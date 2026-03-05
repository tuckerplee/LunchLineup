import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { EmailService } from './email.service';
import { JwtService } from './jwt.service';

@Module({
    providers: [AuthService, JwtService, OtpService, EmailService],
    controllers: [AuthController],
    exports: [AuthService, JwtService],
})
export class AuthModule { }


