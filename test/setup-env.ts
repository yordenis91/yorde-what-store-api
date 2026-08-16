import { config } from 'dotenv';

// Runs before the test file (and AppModule) is loaded. dotenv does not
// overwrite variables already present in process.env, so anything set here
// wins over whatever AppModule's own ConfigModule.forRoot(['.env.local', '.env'])
// would otherwise load — those files are absent in CI and in this sandbox
// anyway.
//
// connection_limit=1 is deliberate, not a default: it forces every request in
// a test to share the single physical connection Prisma holds, which is what
// makes connection-reuse bugs (a later request inheriting Postgres session
// state a transaction left behind) reproduce every time instead of only under
// production's connection-pool luck.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://yws_test:yws_test@localhost:5432/yws_test?schema=public&connection_limit=1';

config({ path: '.env.test' });
process.env.DATABASE_URL = DATABASE_URL;
