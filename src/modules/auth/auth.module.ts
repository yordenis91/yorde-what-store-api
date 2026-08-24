import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: { expiresIn: config.get<string>('jwt.expiresIn') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  // JwtModule re-exported so other modules (customers) share this one JwtService
  // instance instead of registering their own — two JwtModule registrations in
  // the graph make `app.get(JwtService)` ambiguous about which default secret
  // it resolves to. Safe here because every .sign()/.verify() call in this
  // codebase passes its own explicit `secret`, so no module ever relies on
  // JwtModule's own default.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
