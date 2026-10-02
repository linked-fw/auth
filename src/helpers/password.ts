import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Person } from '@_linked/schema/shapes/Person';
import { AuthCredential } from '../shapes/AuthCredential.js';
import { QResult } from '@_linked/core/queries/SelectQuery';

/**
 * PasswordHelper
 */
const PasswordHelper = {
  /**
   * generate a hashed password
   *
   * @param plainTextPassword
   * @returns
   */
  async generateHashedPassword(plainTextPassword: string) {
    try {
      const saltRounds = 12; // bcrypt cost factor. The cost is stored in each hash, so raising it leaves existing hashes valid.
      const hashedPassword = await bcrypt.hash(plainTextPassword, saltRounds);
      return hashedPassword;
    } catch (error) {
      throw error;
    }
  },

  /**
   * generate a new token
   *
   * @returns
   */
  generateToken() {
    // before use this function to generate a new token, for now we change it to use crypto.randomBytes
    // const newToken = URL.createObjectURL(new Blob([])).slice(-36).replace(/-/g, '');
    return crypto.randomBytes(20).toString('hex');
  },

  /**
   * Compare the entered password with the hashed password
   *
   * @param enteredPassword
   * @param hashedPassword
   * @returns
   */
  async checkPassword(enteredPassword: string, hashedPassword: string) {
    const comparedPassword = await bcrypt
      .compare(enteredPassword, hashedPassword)
      .catch((err) => {
        console.error('This email and password combination is incorrect');
        return false;
      });

    return comparedPassword;
  },

  /**
   * Validate the reset password token
   *
   * @param token - The reset password token
   * @returns
   */
  async validateResetPasswordToken(token: string): Promise<QResult<Person>> {
    //check if there is ANY password with this token. If yes, return the userAccount.
    const password = await AuthCredential.select((cred) => cred.credentialOf)
      .where((cred) => {
        return cred.forgotPasswordToken.equals(token);
      })
      .one();
    return password?.credentialOf;
  },
};

export default PasswordHelper;
