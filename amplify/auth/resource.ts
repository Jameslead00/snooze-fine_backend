import { defineAuth, secret } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailStyle: 'CODE',
      verificationEmailSubject: 'Your SnoozeFine verification code',
      verificationEmailBody: (createCode) => `Your SnoozeFine verification code is ${createCode()}`,
    },
    externalProviders: {
      signInWithApple: {
        clientId: secret('SIWA_CLIENT_ID'),
        keyId: secret('SIWA_KEY_ID'),
        privateKey: secret('SIWA_PRIVATE_KEY'),
        teamId: secret('SIWA_TEAM_ID'),
        scopes: ['name', 'email'],
      },
      callbackUrls: ['snoozefine://callback/'],
      logoutUrls: ['snoozefine://signout/'],
    },
  },
  groups: ['ADMINS'],
});
