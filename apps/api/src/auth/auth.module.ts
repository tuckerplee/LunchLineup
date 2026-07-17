import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { EmailService } from './email.service';
import { JwtService } from './jwt.service';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { EmailDeliveryModule } from '../email-delivery/email-delivery.module';

import { OnboardingSignupService } from './onboarding-signup.service';
@Module({
    imports: [EmailDeliveryModule],
    providers: [AuthService, JwtService, OtpService, EmailService, RbacService, TenantPrismaService, OnboardingSignupService],
    controllers: [AuthController],
    exports: [AuthService, JwtService, RbacService],
})
export class AuthModule { }

