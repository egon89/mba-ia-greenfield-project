import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';

export interface LoggedInUser {
  access_token: string;
  refresh_token: string;
}

// Registers, confirms (capturing the token instead of reading the email) and
// logs in a user — same flow as test/auth.e2e-spec.ts.
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<LoggedInUser> {
  const authService = app.get(AuthService);
  const mailService = (
    authService as unknown as {
      mailService: { sendConfirmationEmail: (...args: string[]) => unknown };
    }
  ).mailService;
  let token = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, t: string) => {
      token = t;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    access_token: (res.body as LoggedInUser).access_token,
    refresh_token: (res.body as LoggedInUser).refresh_token,
  };
}
