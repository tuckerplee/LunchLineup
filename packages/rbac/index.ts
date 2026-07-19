import * as path from 'path';
import * as fs from 'fs';

function packageFilePath(filename: string): string {
    const candidates = [
        path.resolve(__dirname, filename),
        path.resolve(__dirname, '..', filename),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    return found ?? candidates[0];
}

export const MODEL_PATH = packageFilePath('model.conf');
export const POLICY_PATH = packageFilePath('policy.csv');

export * from 'casbin';
export * from './permissions';
