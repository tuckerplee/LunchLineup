import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { EmailService } from './email.service';
import { JwtService } from './jwt.service';
import { RbacService } from './rbac.service';

@Module({
    providers: [AuthService, JwtService, OtpService, EmailService, RbacService],
    controllers: [AuthController],
    exports: [AuthService, JwtService, RbacService],
})
export class AuthModule { }

