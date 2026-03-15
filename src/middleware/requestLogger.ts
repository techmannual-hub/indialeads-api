import morgan, { StreamOptions } from 'morgan';
import { env } from '../config/env';

const stream: StreamOptions = {
  write: (message) => console.log(message.trimEnd()),
};

const skip = () => env.NODE_ENV === 'test';

export const requestLogger = morgan(
  env.NODE_ENV === 'development' ? 'dev' : 'combined',
  { stream, skip }
);
