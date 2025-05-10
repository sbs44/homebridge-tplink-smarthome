/**
 * HTTP Client for KLAP protocol communication
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { URL } from 'url';
import * as crypto from 'crypto';

export interface HttpClientOptions {
  timeout?: number;
  baseUrl?: string;
}

export class HttpClient {
  private client: AxiosInstance;
  private cookies: Map<string, string> = new Map();
  private lastUrl: URL | null = null;
  private waitBetweenRequests = 0;
  private lastRequestTime = 0;

  // Some devices close HTTP connection after each request
  private static readonly WAIT_BETWEEN_REQUESTS_ON_ERROR = 250; // ms

  constructor(private host: string, private options: HttpClientOptions = {}) {
    this.client = axios.create({
      timeout: options.timeout || 5000,
    });
  }

  /**
   * Send an HTTP POST request to the device
   */
  async post(
    url: URL,
    data?: Buffer | any,
    params?: Record<string, any>,
    headers?: Record<string, string>,
    cookiesDict?: Record<string, string>,
  ): Promise<[number, Buffer | any]> {
    // Sequential delay if needed
    if (this.waitBetweenRequests > 0) {
      const now = Date.now();
      const gap = now - this.lastRequestTime;
      if (gap < this.waitBetweenRequests) {
        const sleep = this.waitBetweenRequests - gap;
        await new Promise(resolve => setTimeout(resolve, sleep));
      }
    }

    this.lastUrl = url;
    this.clearCookies();

    const cookieHeader = this.formatCookieHeader(cookiesDict);

    try {
      const config: AxiosRequestConfig = {
        params,
        headers: {
          ...headers,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        responseType: 'arraybuffer',
      };

      const response: AxiosResponse = await this.client.post(url.toString(), data, config);

      // Store cookies from response
      this.parseCookies(response.headers['set-cookie']);

      if (response.status === 200) {
        return [response.status, response.data];
      } else {
        console.log(`Device ${this.host} received status code ${response.status}`);
        return [response.status, response.data];
      }
    } catch (error: any) {
      // Handle connection errors
      if (error.code === 'ECONNRESET' || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        if (!this.waitBetweenRequests) {
          console.debug(`Device ${this.host} received an os error, enabling sequential request delay`);
          this.waitBetweenRequests = HttpClient.WAIT_BETWEEN_REQUESTS_ON_ERROR;
        }
        this.lastRequestTime = Date.now();
        throw new Error(`Device connection error: ${this.host}: ${error.message}`);
      }

      // Handle timeout errors
      if (error.code === 'ETIMEDOUT') {
        throw new Error(`Device timeout: ${this.host}: ${error.message}`);
      }

      throw new Error(`Unable to query the device: ${this.host}: ${error.message}`);
    } finally {
      if (this.waitBetweenRequests) {
        this.lastRequestTime = Date.now();
      }
    }
  }

  /**
   * Get a cookie by name
   */
  getCookie(cookieName: string): string | undefined {
    return this.cookies.get(cookieName);
  }

  /**
   * Clear all cookies
   */
  clearCookies(): void {
    this.cookies.clear();
  }

  /**
   * Parse cookies from Set-Cookie headers
   */
  private parseCookies(setCookieHeaders?: string[]): void {
    if (!setCookieHeaders) return;

    for (const header of setCookieHeaders) {
      const cookieParts = header.split(';')[0].split('=');
      if (cookieParts.length === 2) {
        const [name, value] = cookieParts;
        this.cookies.set(name, value);
      }
    }
  }

  /**
   * Format cookie header from dictionary
   */
  private formatCookieHeader(cookiesDict?: Record<string, string>): string {
    if (!cookiesDict) return '';

    return Object.entries(cookiesDict)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Close the client
   */
  async close(): Promise<void> {
    // Nothing to do for axios
  }
}