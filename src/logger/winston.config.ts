import { utilities as nestWinstonUtilities } from 'nest-winston';
import * as winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';

export const winstonLoggerOptions: winston.LoggerOptions = {
  level: isProduction ? 'info' : 'debug',
  format: isProduction
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(
        winston.format.timestamp(),
        nestWinstonUtilities.format.nestLike('YWS', { prettyPrint: true, colors: true }),
      ),
  transports: [new winston.transports.Console()],
};
