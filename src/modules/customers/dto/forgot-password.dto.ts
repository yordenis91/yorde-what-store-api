import { IsEmail } from 'class-validator';

export class ForgotPasswordCustomerDto {
  @IsEmail()
  email: string;
}
