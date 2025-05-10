/**
 * Class to store device credentials
 */
export class Credentials {
  /**
   * Create a credentials object
   *
   * @param username - Email address for TP-Link/Kasa account
   * @param password - Password for TP-Link/Kasa account
   */
  constructor(
    public readonly username: string = '',
    public readonly password: string = ''
  ) { }
}

/**
 * Get built-in default credentials
 */
export function getDefaultCredentials(): Credentials {
  return new Credentials('kasa@tp-link.net', 'kasaSetup');
}