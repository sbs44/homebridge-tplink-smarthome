/**
 * Implementation of the TP-Link SMART protocol for KLAP devices
 */
import { KlapTransport } from './klap-transport';
import { Credentials } from './credentials';

export class KlapProtocol {
  // Retry timing
  private static readonly BACKOFF_SECONDS_AFTER_TIMEOUT = 1;
  private static readonly DEFAULT_MULTI_REQUEST_BATCH_SIZE = 5;

  // Instance variables
  private terminalUuid: string;
  private queryLock = false;
  private multiRequestBatchSize: number;
  private methodMissingLogged = false;

  constructor(
    public readonly transport: KlapTransport
  ) {
    // Generate a terminal UUID
    const randomBytes = crypto.randomBytes(16);
    const md5Hash = crypto.createHash('md5').update(randomBytes).digest();
    this.terminalUuid = Buffer.from(md5Hash).toString('base64');

    // Set default batch size
    this.multiRequestBatchSize = KlapProtocol.DEFAULT_MULTI_REQUEST_BATCH_SIZE;
  }

  /**
   * Create a smart request message
   */
  getSmartRequest(method: string, params?: any): string {
    const request: any = {
      method,
      request_time_milis: Date.now(),
      terminal_uuid: this.terminalUuid,
    };

    if (params) {
      request.params = params;
    }

    return JSON.stringify(request);
  }

  /**
   * Query the device with retry mechanism
   */
  async query(request: string | Record<string, any>, retryCount = 3): Promise<any> {
    // Ensure only one query executes at a time
    while (this.queryLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.queryLock = true;
    try {
      return await this._query(request, retryCount);
    } finally {
      this.queryLock = false;
    }
  }

  /**
   * Internal query implementation with retries
   */
  private async _query(request: string | Record<string, any>, retryCount = 3): Promise<any> {
    for (let retry = 0; retry <= retryCount; retry++) {
      try {
        return await this._executeQuery(request, retry, retryCount, true);
      } catch (error: any) {
        // Handle authentication errors (don't retry)
        if (error.message && error.message.includes('authentication')) {
          await this.transport.reset();
          console.debug(`Unable to authenticate with ${this.transport.host}, not retrying: ${error}`);
          throw error;
        }

        // Handle retryable errors
        if (error.message && (
          error.message.includes('transport not available') ||
          error.message.includes('timeout') ||
          error.message.includes('session expired')
        )) {
          if (retry === 0) {
            console.debug(
              `Device ${this.transport.host} got a retryable error, will retry ${retryCount} times: ${error}`
            );
          }

          await this.transport.reset();

          if (retry >= retryCount) {
            console.debug(`Giving up on ${this.transport.host} after ${retry} retries`);
            throw error;
          }

          await new Promise(resolve =>
            setTimeout(resolve, KlapProtocol.BACKOFF_SECONDS_AFTER_TIMEOUT * 1000)
          );
          continue;
        }

        // Any other error is fatal
        await this.transport.reset();
        console.debug(
          `Unable to query the device: ${this.transport.host}, not retrying: ${error}`
        );
        throw error;
      }
    }

    // Should never reach here
    throw new Error("Query reached unreachable code");
  }

  /**
   * Execute multiple requests in a batch
   */
  private async _executeMultipleQuery(
    requests: Record<string, any>,
    retry: number,
    retryCount: number,
    iterateListPages: boolean
  ): Promise<Record<string, any>> {
    const multiResult: Record<string, any> = {};
    const smartMethod = "multipleRequest";

    // Force single request methods to be handled separately
    const forceIndividualMethods = ['getConnectStatus', 'scanApList'];

    const end = Object.keys(requests).length;
    const raiseOnError = end === 1;

    // Filter out methods that must be sent individually
    const multiRequests = Object.entries(requests)
      .filter(([method]) => !forceIndividualMethods.includes(method))
      .map(([method, params]) => params ? { method, params } : { method });

    // Break the requests down based on batch size
    const step = this.multiRequestBatchSize;
    if (step === 1) {
      // If step is 1 do not send request batches
      for (const request of multiRequests) {
        const method = request.method;
        const req = this.getSmartRequest(method, request.params);
        const resp = await this.transport.send(req);
        this._handleResponseErrorCode(resp, method, raiseOnError);
        multiResult[method] = resp.result;
      }
      return multiResult;
    }

    // Process requests in batches
    for (let i = 0; i < end; i += step) {
      const requestsStep = multiRequests.slice(i, i + step);

      const smartParams = { requests: requestsStep };
      const smartRequest = this.getSmartRequest(smartMethod, smartParams);
      const batchNum = Math.floor(i / step) + 1;
      const totalBatches = Math.ceil(end / step);
      const batchName = `multi-request-batch-${batchNum}-of-${totalBatches}`;

      console.debug(
        `${this.transport.host} ${batchName} >> ${smartRequest.slice(0, 100)}...`
      );

      const responseStep = await this.transport.send(smartRequest);

      try {
        this._handleResponseErrorCode(responseStep, batchName);
      } catch (error: any) {
        // Some devices raise JSON_DECODE_FAIL_ERROR on batched requests
        if (
          error.message &&
          (error.message.includes('JSON_DECODE_FAIL_ERROR') ||
            error.message.includes('INTERNAL_UNKNOWN_ERROR'))
        ) {
          if (this.multiRequestBatchSize !== 1) {
            this.multiRequestBatchSize = 1;
            throw new Error("JSON Decode failure, multi requests disabled");
          }
        }
        throw error;
      }

      const responses = responseStep.result.responses;
      for (const response of responses) {
        // Some device calls do not populate the method key
        if (!response.method) {
          if (!this.methodMissingLogged) {
            // Avoid spamming logs
            this.methodMissingLogged = true;
            console.error(
              `No method key in response for ${this.transport.host}, skipping: ${JSON.stringify(responseStep)}`
            );
          }
          continue;
        }

        this._handleResponseErrorCode(response, response.method, raiseOnError);
        const result = response.result;
        const requestParams = requests[response.method];

        if (iterateListPages && result) {
          await this._handleResponseLists(result, response.method, requestParams, retryCount);
        }

        multiResult[response.method] = result;
      }
    }

    // Handle methods that must be queried individually
    for (const method of Object.keys(requests)) {
      if (!multiResult[method] && requests[method] !== undefined) {
        const resp = await this.transport.send(
          this.getSmartRequest(method, requests[method])
        );
        this._handleResponseErrorCode(resp, method, raiseOnError);
        multiResult[method] = resp.result;
      }
    }

    return multiResult;
  }

  /**
   * Execute a query
   */
  private async _executeQuery(
    request: string | Record<string, any>,
    retry: number,
    retryCount: number,
    iterateListPages = true
  ): Promise<any> {
    let smartMethod: string;
    let smartParams: any;

    // Handle different request formats
    if (typeof request === 'object') {
      if (Object.keys(request).length === 1) {
        smartMethod = Object.keys(request)[0];
        smartParams = request[smartMethod];
      } else {
        return await this._executeMultipleQuery(request, retry, retryCount, iterateListPages);
      }
    } else {
      smartMethod = request;
      smartParams = null;
    }

    // Create and send the request
    const smartRequest = this.getSmartRequest(smartMethod, smartParams);
    console.debug(`${this.transport.host} >> ${smartRequest.slice(0, 100)}...`);

    const responseData = await this.transport.send(smartRequest);
    console.debug(`${this.transport.host} << ${JSON.stringify(responseData).slice(0, 100)}...`);

    this._handleResponseErrorCode(responseData, smartMethod);

    // Single set_ requests do not return a result
    const result = responseData.result;
    if (iterateListPages && result) {
      await this._handleResponseLists(result, smartMethod, smartParams, retryCount);
    }

    return { [smartMethod]: result };
  }

  /**
   * Create a list request with pagination
   */
  private _getListRequest(method: string, params: any | null, startIndex: number): Record<string, any> {
    return { [method]: { start_index: startIndex } };
  }

  /**
   * Handle paginated list responses
   */
  private async _handleResponseLists(
    responseResult: any,
    method: string,
    params: any | null,
    retryCount: number
  ): Promise<void> {
    // Check if this is a paginated list response
    if (
      !responseResult ||
      typeof responseResult !== 'object' ||
      responseResult.start_index === undefined ||
      responseResult.sum === undefined
    ) {
      return;
    }

    // Find the list property in the response
    const listKeys = Object.keys(responseResult).filter(
      key => Array.isArray(responseResult[key])
    );

    if (listKeys.length === 0) {
      return;
    }

    const responseListName = listKeys[0];
    let listLength = responseResult[responseListName].length;
    const listSum = responseResult.sum;

    // Fetch additional pages if needed
    while (listLength < listSum) {
      const request = this._getListRequest(method, params, listLength);
      const response = await this._executeQuery(
        request,
        0,
        retryCount,
        false
      );

      const nextBatch = response[method];

      // Avoid infinite loops if device returns empty results
      if (!nextBatch[responseListName] || nextBatch[responseListName].length === 0) {
        console.error(`Device ${this.transport.host} returned empty results list for method ${method}`);
        break;
      }

      // Append new items to the list
      responseResult[responseListName].push(...nextBatch[responseListName]);
      listLength = responseResult[responseListName].length;
    }
  }

  /**
   * Handle error codes in responses
   */
  private _handleResponseErrorCode(
    respDict: any,
    method: string,
    raiseOnError = true
  ): void {
    const errorCode = respDict.error_code;

    // Success case
    if (errorCode === 0) {
      return;
    }

    // If not raising errors, just store the error code
    if (!raiseOnError) {
      respDict.result = errorCode;
      return;
    }

    // Handle specific error types
    const errorName = this._getErrorName(errorCode);
    const msg = `Error querying device: ${this.transport.host}: ${errorName}(${errorCode}) for method: ${method}`;

    // Retryable errors
    if (
      errorCode === 9999 || // SESSION_TIMEOUT_ERROR
      errorCode === 1002 || // TRANSPORT_NOT_AVAILABLE_ERROR
      errorCode === -1001 || // UNSPECIFIC_ERROR
      errorCode === -40401 || // SESSION_EXPIRED
      errorCode === -40413 // INVALID_NONCE
    ) {
      throw new Error(msg);
    }

    // Authentication errors
    if (
      errorCode === -1501 || // LOGIN_ERROR
      errorCode === 1111 || // LOGIN_FAILED_ERROR
      errorCode === -1005 || // AES_DECODE_FAIL_ERROR
      errorCode === 1100 || // HAND_SHAKE_FAILED_ERROR
      errorCode === 1003 || // TRANSPORT_UNKNOWN_CREDENTIALS_ERROR
      errorCode === -40412 // HOMEKIT_LOGIN_FAIL
    ) {
      throw new Error(`Authentication error: ${msg}`);
    }

    // Other device errors
    throw new Error(msg);
  }

  /**
   * Get a human-readable name for error codes
   */
  private _getErrorName(code: number): string {
    const errorCodes: Record<number, string> = {
      0: 'SUCCESS',
      9999: 'SESSION_TIMEOUT_ERROR',
      1200: 'MULTI_REQUEST_FAILED_ERROR',
      1112: 'HTTP_TRANSPORT_FAILED_ERROR',
      1111: 'LOGIN_FAILED_ERROR',
      1100: 'HAND_SHAKE_FAILED_ERROR',
      1003: 'TRANSPORT_UNKNOWN_CREDENTIALS_ERROR',
      1002: 'TRANSPORT_NOT_AVAILABLE_ERROR',
      1001: 'CMD_COMMAND_CANCEL_ERROR',
      1000: 'NULL_TRANSPORT_ERROR',
      [-1]: 'COMMON_FAILED_ERROR',
      [-1001]: 'UNSPECIFIC_ERROR',
      [-1002]: 'UNKNOWN_METHOD_ERROR',
      [-1003]: 'JSON_DECODE_FAIL_ERROR',
      [-1004]: 'JSON_ENCODE_FAIL_ERROR',
      [-1005]: 'AES_DECODE_FAIL_ERROR',
      [-1006]: 'REQUEST_LEN_ERROR_ERROR',
      [-1007]: 'CLOUD_FAILED_ERROR',
      [-1008]: 'PARAMS_ERROR',
      [-1501]: 'LOGIN_ERROR',
      [-40401]: 'SESSION_EXPIRED',
      [-40411]: 'BAD_USERNAME',
      [-40412]: 'HOMEKIT_LOGIN_FAIL',
      [-40413]: 'INVALID_NONCE',
    };

    return errorCodes[code] || `UNKNOWN_ERROR_${code}`;
  }

  /**
   * Close the protocol and transport
   */
  async close(): Promise<void> {
    await this.transport.close();
  }
}