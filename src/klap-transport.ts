/**
 * Implementation of the KLAP encryption transport protocol
 *
 * KLAP is the name used in device discovery for TP-Link's newer
 * encryption protocol, used by devices with newer firmware versions.
 */
import { URL } from 'url';
import * as crypto from 'crypto';
import { HttpClient } from './http-client';
import { Credentials } from './credentials';

// Constants
const ONE_DAY_SECONDS = 86400;
const SESSION_EXPIRE_BUFFER_SECONDS = 60 * 20; // 20 minutes buffer

// Cookie names
const SESSION_COOKIE_NAME = 'TP_SESSIONID';
const TIMEOUT_COOKIE_NAME = 'TIMEOUT';

export class KlapEncryptionSession {
  private key: Buffer;
  private iv: Buffer;
  private seq: number;
  private sig: Buffer;

  constructor(
    public readonly localSeed: Buffer,
    public readonly remoteSeed: Buffer,
    public readonly userHash: Buffer
  ) {
    // Initialize encryption components
    this.key = this.keyDerive(localSeed, remoteSeed, userHash);
    [this.iv, this.seq] = this.ivDerive(localSeed, remoteSeed, userHash);
    this.sig = this.sigDerive(localSeed, remoteSeed, userHash);
  }

  /**
   * Derive encryption key from seeds and user hash
   */
  private keyDerive(localSeed: Buffer, remoteSeed: Buffer, userHash: Buffer): Buffer {
    const payload = Buffer.concat([
      Buffer.from('lsk'),
      localSeed,
      remoteSeed,
      userHash
    ]);
    return crypto.createHash('sha256').update(payload).digest().slice(0, 16);
  }

  /**
   * Derive initialization vector and sequence number
   */
  private ivDerive(localSeed: Buffer, remoteSeed: Buffer, userHash: Buffer): [Buffer, number] {
    // IV is first 16 bytes of sha256, where the last 4 bytes form
    // the sequence number used in requests, incremented on each request
    const payload = Buffer.concat([
      Buffer.from('iv'),
      localSeed,
      remoteSeed,
      userHash
    ]);
    const fullIv = crypto.createHash('sha256').update(payload).digest();
    const seq = fullIv.readInt32BE(28); // Last 4 bytes as sequence number
    return [fullIv.slice(0, 12), seq]; // Return first 12 bytes as IV
  }

  /**
   * Derive signature key
   */
  private sigDerive(localSeed: Buffer, remoteSeed: Buffer, userHash: Buffer): Buffer {
    // Used to create a hash to prefix each request
    const payload = Buffer.concat([
      Buffer.from('ldk'),
      localSeed,
      remoteSeed,
      userHash
    ]);
    return crypto.createHash('sha256').update(payload).digest().slice(0, 28);
  }

  /**
   * Encrypt a message
   */
  encrypt(msg: string | Buffer): { data: Buffer, seq: number } {
    // Increment sequence number
    this.seq += 1;

    // Create IV with sequence number
    const ivSeq = Buffer.alloc(16);
    this.iv.copy(ivSeq, 0, 0, 12);
    ivSeq.writeInt32BE(this.seq, 12);

    // Pad the data (PKCS7)
    const msgBuffer = typeof msg === 'string' ? Buffer.from(msg, 'utf-8') : msg;
    const padder = crypto.createCipheriv('aes-128-cbc', Buffer.alloc(16), Buffer.alloc(16));
    padder.setAutoPadding(true);

    // Encrypt the data
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, ivSeq);
    cipher.setAutoPadding(false);

    // Create proper padding
    const padLength = 16 - (msgBuffer.length % 16);
    const padding = Buffer.alloc(padLength, padLength);
    const paddedData = Buffer.concat([msgBuffer, padding]);

    // Encrypt the data
    const ciphertext = cipher.update(paddedData);
    const finalCipher = Buffer.concat([ciphertext, cipher.final()]);

    // Create signature
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(this.seq, 0);
    const signature = crypto.createHash('sha256')
      .update(Buffer.concat([this.sig, seqBuf, finalCipher]))
      .digest();

    // Combine signature and ciphertext
    return {
      data: Buffer.concat([signature, finalCipher]),
      seq: this.seq
    };
  }

  /**
   * Decrypt a message
   */
  decrypt(msg: Buffer): string {
    // Create IV with sequence number
    const ivSeq = Buffer.alloc(16);
    this.iv.copy(ivSeq, 0, 0, 12);
    ivSeq.writeInt32BE(this.seq, 12);

    // Extract ciphertext (skip 32-byte signature)
    const ciphertext = msg.slice(32);

    // Decrypt the data
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, ivSeq);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Handle PKCS7 padding
    const padLength = decrypted[decrypted.length - 1];
    const unpadded = decrypted.slice(0, decrypted.length - padLength);

    return unpadded.toString('utf-8');
  }
}

export class KlapTransport {
  // Default ports
  private static readonly DEFAULT_PORT = 80;
  private static readonly DEFAULT_HTTPS_PORT = 4433;

  // Instance properties
  private httpClient: HttpClient;
  private localSeed: Buffer | null = null;
  private handshakeLock = false;
  private handshakeDone = false;
  private sessionExpireAt: number | null = null;
  private sessionCookie: Record<string, string> | null = null;
  private encryptionSession: KlapEncryptionSession | null = null;
  private localAuthHash: Buffer;
  private appUrl: URL;
  private requestUrl: URL;

  // Backup credentials for devices that sometimes switch auth requirements
  private defaultCredentialsAuthHash: Record<string, Buffer> = {};
  private blankAuthHash: Buffer | null = null;

  constructor(
    public readonly host: string,
    public readonly credentials: Credentials,
    public readonly port: number = KlapTransport.DEFAULT_PORT,
    public readonly timeout: number = 5000
  ) {
    this.httpClient = new HttpClient(host, { timeout });
    this.localAuthHash = KlapTransport.generateAuthHash(credentials.username, credentials.password);

    // Create URLs
    this.appUrl = new URL(`http://${host}:${port}/app`);
    this.requestUrl = new URL(`http://${host}:${port}/app/request`);
  }

  /**
   * Generate auth hash from username and password
   */
  static generateAuthHash(username: string, password: string): Buffer {
    const unHash = crypto.createHash('md5').update(username).digest();
    const pwHash = crypto.createHash('md5').update(password).digest();
    return crypto.createHash('md5').update(Buffer.concat([unHash, pwHash])).digest();
  }

  /**
   * Generate hash for handshake1
   */
  static handshake1SeedAuthHash(localSeed: Buffer, remoteSeed: Buffer, authHash: Buffer): Buffer {
    return crypto.createHash('sha256').update(Buffer.concat([localSeed, authHash])).digest();
  }

  /**
   * Generate hash for handshake2
   */
  static handshake2SeedAuthHash(localSeed: Buffer, remoteSeed: Buffer, authHash: Buffer): Buffer {
    return crypto.createHash('sha256').update(Buffer.concat([remoteSeed, authHash])).digest();
  }

  /**
   * Perform first handshake exchange with device
   */
  async performHandshake1(): Promise<{ localSeed: Buffer; remoteSeed: Buffer; authHash: Buffer }> {
    // Generate random local seed
    const localSeed = crypto.randomBytes(16);

    // Handshake 1 has a payload of local_seed and a response of 16 bytes,
    // followed by sha256(local_seed | auth_hash)
    const url = new URL(`${this.appUrl}/handshake1`);

    const [responseStatus, responseData] = await this.httpClient.post(url, localSeed);

    if (responseStatus !== 200) {
      throw new Error(`Device ${this.host} responded with ${responseStatus} to handshake1`);
    }

    if (!Buffer.isBuffer(responseData) || responseData.length < 48) {
      throw new Error(`Device ${this.host} responded with unexpected data format to handshake1`);
    }

    // Extract remote seed and server hash
    const remoteSeed = responseData.slice(0, 16);
    const serverHash = responseData.slice(16, 48);

    console.debug(`Handshake1 success. Host: ${this.host}, Server remote_seed: ${remoteSeed.toString('hex')}`);

    // Check with our credentials
    const localSeedAuthHash = KlapTransport.handshake1SeedAuthHash(
      localSeed,
      remoteSeed,
      this.localAuthHash
    );

    if (localSeedAuthHash.equals(serverHash)) {
      console.debug('Handshake1 hashes match with expected credentials');
      return { localSeed, remoteSeed, authHash: this.localAuthHash };
    }

    // Try default Kasa credentials (for devices that have been connected to cloud)
    const defaultCreds = {
      username: 'kasa@tp-link.net',
      password: 'kasaSetup',
    };

    if (!this.defaultCredentialsAuthHash['KASA']) {
      this.defaultCredentialsAuthHash['KASA'] = KlapTransport.generateAuthHash(
        defaultCreds.username,
        defaultCreds.password
      );
    }

    const defaultCredsSeedAuthHash = KlapTransport.handshake1SeedAuthHash(
      localSeed,
      remoteSeed,
      this.defaultCredentialsAuthHash['KASA']
    );

    if (defaultCredsSeedAuthHash.equals(serverHash)) {
      console.debug(
        `Device response did not match our expected hash on ip ${this.host}, ` +
        'but authentication with KASA default credentials worked'
      );
      return { localSeed, remoteSeed, authHash: this.defaultCredentialsAuthHash['KASA'] };
    }

    // Try blank credentials if not already using them
    if (this.credentials.username !== '' || this.credentials.password !== '') {
      if (!this.blankAuthHash) {
        this.blankAuthHash = KlapTransport.generateAuthHash('', '');
      }

      const blankSeedAuthHash = KlapTransport.handshake1SeedAuthHash(
        localSeed,
        remoteSeed,
        this.blankAuthHash
      );

      if (blankSeedAuthHash.equals(serverHash)) {
        console.debug(
          `Device response did not match our expected hash on ip ${this.host}, ` +
          'but authentication with blank credentials worked'
        );
        return { localSeed, remoteSeed, authHash: this.blankAuthHash };
      }
    }

    // No credential match found
    throw new Error(
      `Device response did not match our challenge on ip ${this.host}, ` +
      'check that your username and password are correct.'
    );
  }

  /**
   * Perform second handshake to confirm authentication
   */
  async performHandshake2(
    localSeed: Buffer,
    remoteSeed: Buffer,
    authHash: Buffer
  ): Promise<KlapEncryptionSession> {
    // Handshake 2 payload is sha256(remoteSeed | authenticator)
    const url = new URL(`${this.appUrl}/handshake2`);

    const payload = KlapTransport.handshake2SeedAuthHash(localSeed, remoteSeed, authHash);

    const [responseStatus, _] = await this.httpClient.post(
      url,
      payload,
      undefined,
      undefined,
      this.sessionCookie
    );

    if (responseStatus !== 200) {
      throw new Error(`Device ${this.host} responded with ${responseStatus} to handshake2`);
    }

    return new KlapEncryptionSession(localSeed, remoteSeed, authHash);
  }

  /**
   * Perform full handshake (both steps)
   */
  async performHandshake(): Promise<void> {
    console.debug(`Starting handshake with ${this.host}`);

    // Reset handshake state
    this.handshakeDone = false;
    this.sessionExpireAt = null;
    this.sessionCookie = null;

    // Perform handshake1
    const { localSeed, remoteSeed, authHash } = await this.performHandshake1();

    // Store session cookie if available
    const sessionCookieValue = this.httpClient.getCookie(SESSION_COOKIE_NAME);
    if (sessionCookieValue) {
      this.sessionCookie = { [SESSION_COOKIE_NAME]: sessionCookieValue };
    }

    // Get timeout from cookie or use default
    const timeout = Number(this.httpClient.getCookie(TIMEOUT_COOKIE_NAME) || ONE_DAY_SECONDS);

    // Set session expiration (with buffer to ensure we refresh before server expires)
    this.sessionExpireAt = Date.now() + (timeout * 1000) - (SESSION_EXPIRE_BUFFER_SECONDS * 1000);

    // Perform handshake2
    this.encryptionSession = await this.performHandshake2(localSeed, remoteSeed, authHash);

    // Mark handshake as complete
    this.handshakeDone = true;

    console.debug(`Handshake with ${this.host} complete`);
  }

  /**
   * Check if session has expired
   */
  private handshakeSessionExpired(): boolean {
    return !this.sessionExpireAt || this.sessionExpireAt <= Date.now();
  }

  /**
   * Send a request to the device
   */
  async send(request: string): Promise<any> {
    // Check if handshake is needed
    if (!this.handshakeDone || this.handshakeSessionExpired()) {
      // Ensure only one handshake happens at a time
      if (!this.handshakeLock) {
        this.handshakeLock = true;
        try {
          await this.performHandshake();
        } finally {
          this.handshakeLock = false;
        }
      } else {
        // Wait for existing handshake to complete
        while (this.handshakeLock) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Double check after waiting
        if (!this.handshakeDone || this.handshakeSessionExpired()) {
          await this.performHandshake();
        }
      }
    }

    if (!this.encryptionSession) {
      throw new Error(`No encryption session available for ${this.host}`);
    }

    // Encrypt the request
    const { data: payload, seq } = this.encryptionSession.encrypt(request);

    // Send the request
    const [responseStatus, responseData] = await this.httpClient.post(
      this.requestUrl,
      payload,
      { seq },
      undefined,
      this.sessionCookie
    );

    console.debug(`Device ${this.host} query posted. Sequence: ${seq}, Status: ${responseStatus}`);

    if (responseStatus !== 200) {
      // If security error, force new handshake next time
      if (responseStatus === 403) {
        this.handshakeDone = false;
        throw new Error(`Device ${this.host} security error, will retry with new handshake`);
      } else {
        throw new Error(`Device ${this.host} responded with ${responseStatus} to request with seq ${seq}`);
      }
    }

    try {
      // Decrypt the response
      const decryptedResponse = this.encryptionSession.decrypt(responseData as Buffer);

      // Parse the response
      return JSON.parse(decryptedResponse);
    } catch (error) {
      throw new Error(`Error decrypting device ${this.host} response: ${error}`);
    }
  }

  /**
   * Reset the handshake state
   */
  async reset(): Promise<void> {
    this.handshakeDone = false;
  }

  /**
   * Close the transport
   */
  async close(): Promise<void> {
    await this.reset();
    await this.httpClient.close();
  }
}