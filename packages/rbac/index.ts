import * as path from 'path';

export const MODEL_PATH = path.resolve(__dirname, '../model.conf');
export const POLICY_PATH = path.resolve(__dirname, '../policy.csv');

export * from 'casbin';
