<?php
declare(strict_types=1);

require __DIR__ . '/password_crypto.php';
require_once __DIR__ . '/../src/crypto.php';

function transformSql(string $sql, callable $transform): string
{
    $pattern = "/'((?:[^'\\\\]|\\\\.)*)'/";
    return (string)preg_replace_callback($pattern, function (array $matches) use ($transform) {
        $value = stripslashes($matches[1]);
        $new = $transform($value);
        return "'" . addslashes($new) . "'";
    }, $sql);
}

function scheduler_backup_run(string $file, string $password, string &$output = '', ?callable $progress = null): int
{
    $say = static function (string $msg) use (&$output, $progress): void {
        if ($progress !== null) {
            $progress($msg);
        }
        $output .= $msg;
    };
    if ($password === '') {
        $say("Missing password\n");
        return 1;
    }

    $configFile = __DIR__ . '/../config.php';
    if (!file_exists($configFile)) {
        $say("Missing config.php\n");
        return 1;
    }

    $config = require $configFile;

    $say("Dumping database...\n");
    $temp = tempnam(sys_get_temp_dir(), 'dump');
    $dumpCmd = 'mysqldump --host=' . escapeshellarg($config['host'])
        . ' --user=' . escapeshellarg($config['user'])
        . ' --password=' . escapeshellarg($config['pass'])
        . ' ' . escapeshellarg($config['dbname'])
        . ' > ' . escapeshellarg($temp);

    ob_start();
    passthru($dumpCmd, $status);
    $output .= ob_get_clean();
    if ($status !== 0) {
        unlink($temp);
        $say("Dump failed with exit code $status\n");
        return $status;
    }
    $say("Dump complete.\n");

    $sql = file_get_contents($temp);
    $sql = transformSql($sql, function (string $value) use ($password): string {
        $decrypted = decryptField($value);
        if ($decrypted === $value) {
            return $value;
        }
        return encrypt_with_password($decrypted, $password);
    });
    file_put_contents($temp, $sql);

    $say("Encrypting backup...\n");
    $encryptCmd = 'openssl enc -aes-256-cbc -salt -pass pass:' . escapeshellarg($password)
        . ' -in ' . escapeshellarg($temp)
        . ' -out ' . escapeshellarg($file);

    ob_start();
    passthru($encryptCmd, $status);
    $output .= ob_get_clean();
    unlink($temp);

    if ($status !== 0) {
        $say("Encryption failed with exit code $status\n");
    } else {
        $say("Encryption complete.\n");
    }

    return $status;
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    if ($argc < 3) {
        fwrite(STDERR, "Usage: php backup.php <file.sql.enc> <password>\n");
        exit(1);
    }

    $output = '';
    $status = scheduler_backup_run($argv[1], $argv[2], $output);
    if ($output !== '') {
        $stream = $status === 0 ? STDOUT : STDERR;
        fwrite($stream, $output);
    }
    exit($status);
}
