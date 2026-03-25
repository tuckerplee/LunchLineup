<?php
declare(strict_types=1);

/**
 * Run each *_test.php file and return structured results.
 *
 * @param string|null $filter Optional substring filter applied to file names.
 *
 * @return array{
 *     exitCode:int,
 *     results:list<array{
 *         name:string,
 *         exitCode:int,
 *         stdout:string,
 *         stderr:string,
 *         message:?string
 *     }>,
 *     summary:array{total:int,passed:int,failed:int},
 *     message:?string,
 *     configRestored:bool
 * }
 */
function runTestSuite(?string $filter = null): array
{
    $testDir     = __DIR__;
    $projectRoot = dirname(__DIR__);
    $phpBinary   = PHP_BINARY;

    $tests = array_values(array_filter(
        glob($testDir . DIRECTORY_SEPARATOR . '*_test.php'),
        static fn (string $path): bool => is_file($path)
    ));

    sort($tests);

    if ($tests === []) {
        return [
            'exitCode'       => 1,
            'results'        => [],
            'summary'        => ['total' => 0, 'passed' => 0, 'failed' => 0],
            'message'        => 'No tests found.',
            'configRestored' => true,
        ];
    }

    if ($filter !== null) {
        $filtered = array_values(array_filter(
            $tests,
            static fn (string $path): bool => strpos(basename($path), $filter) !== false
        ));

        if ($filtered === []) {
            return [
                'exitCode'       => 1,
                'results'        => [],
                'summary'        => ['total' => 0, 'passed' => 0, 'failed' => 0],
                'message'        => "No tests matched filter '{$filter}'.",
                'configRestored' => true,
            ];
        }

        $tests = $filtered;
    }

    $configPath     = $projectRoot . DIRECTORY_SEPARATOR . 'config.php';
    $hadConfig      = file_exists($configPath);
    $originalConfig = $hadConfig ? file_get_contents($configPath) : null;

    $restoreConfig = static function () use ($configPath, $hadConfig, $originalConfig): void {
        clearstatcache(true, $configPath);
        if ($hadConfig) {
            file_put_contents($configPath, (string) $originalConfig);
        } elseif (file_exists($configPath)) {
            unlink($configPath);
        }
        clearstatcache(true, $configPath);
    };

    $previousEnv = [];
    foreach (['APP_ENV', 'TEST_SUITE'] as $key) {
        $value = getenv($key);
        $previousEnv[$key] = [
            'exists' => $value !== false,
            'value'  => $value !== false ? $value : null,
        ];
    }

    $results  = [];
    $exitCode = 0;

    try {
        putenv('APP_ENV=test');
        $_ENV['APP_ENV'] = 'test';
        putenv('TEST_SUITE=1');
        $_ENV['TEST_SUITE'] = '1';

        foreach ($tests as $test) {
            $name = basename($test);

            $descriptors = [
                0 => ['pipe', 'r'],
                1 => ['pipe', 'w'],
                2 => ['pipe', 'w'],
            ];

            $process = proc_open([$phpBinary, $test], $descriptors, $pipes, $projectRoot, null);

            if (!is_resource($process)) {
                $results[] = [
                    'name'     => $name,
                    'exitCode' => 1,
                    'stdout'   => '',
                    'stderr'   => '',
                    'message'  => 'Failed to start PHP process.',
                ];
                $exitCode = 1;
                $restoreConfig();
                continue;
            }

            fclose($pipes[0]);
            $stdout = stream_get_contents($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);

            $code = proc_close($process);

            if ($code !== 0) {
                $exitCode = 1;
            }

            $results[] = [
                'name'     => $name,
                'exitCode' => $code,
                'stdout'   => $stdout === false ? '' : $stdout,
                'stderr'   => $stderr === false ? '' : $stderr,
                'message'  => null,
            ];

            $restoreConfig();
        }
    } finally {
        $restoreConfig();
        foreach ($previousEnv as $key => $snapshot) {
            if ($snapshot['exists'] === false) {
                putenv($key);
                unset($_ENV[$key]);
            } else {
                putenv($key . '=' . (string) $snapshot['value']);
                $_ENV[$key] = (string) $snapshot['value'];
            }
        }
    }

    clearstatcache(true, $configPath);
    $configRestored = $hadConfig
        ? (file_exists($configPath) && file_get_contents($configPath) === (string) $originalConfig)
        : !file_exists($configPath);

    $passed = 0;
    foreach ($results as $result) {
        if ($result['exitCode'] === 0) {
            $passed++;
        }
    }

    $total  = count($results);
    $failed = $total - $passed;

    return [
        'exitCode'       => $exitCode,
        'results'        => $results,
        'summary'        => ['total' => $total, 'passed' => $passed, 'failed' => $failed],
        'message'        => null,
        'configRestored' => $configRestored,
    ];
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    $filter = $argc > 1 ? (string) $argv[1] : null;

    $suite = runTestSuite($filter);

    if ($suite['results'] === [] && $suite['message'] !== null) {
        $stream = $suite['exitCode'] === 0 ? STDOUT : STDERR;
        fwrite($stream, $suite['message'] . PHP_EOL);
        exit($suite['exitCode']);
    }

    foreach ($suite['results'] as $result) {
        echo '▶ Running ' . $result['name'] . PHP_EOL;
        if ($result['stdout'] !== '') {
            echo rtrim($result['stdout']) . PHP_EOL;
        }
        if ($result['stderr'] !== '') {
            fwrite(STDERR, rtrim($result['stderr']) . PHP_EOL);
        }
        if ($result['message'] !== null) {
            echo $result['message'] . PHP_EOL;
        }
        if ($result['exitCode'] === 0) {
            echo '✔ ' . $result['name'] . ' passed' . PHP_EOL;
        } else {
            echo '✘ ' . $result['name'] . ' failed (exit code ' . $result['exitCode'] . ')' . PHP_EOL;
        }
        echo PHP_EOL;
    }

    $summary = $suite['summary'];
    echo 'Summary: ' . $summary['passed'] . '/' . $summary['total'] . ' tests passed';
    if ($summary['failed'] > 0) {
        echo ', ' . $summary['failed'] . ' failed';
    }
    echo PHP_EOL;

    if ($suite['configRestored'] === false) {
        echo 'Warning: config.php was not restored to its original state.' . PHP_EOL;
    }

    exit($suite['exitCode']);
}