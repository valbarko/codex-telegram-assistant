<?php

declare(strict_types=1);

/** Hourly owner payment digest. The systemd timer and this guard both enforce Moscow hours. */
final class ServerPaymentAlerts
{
    private const PROJECTS = ['tvk', 'gmk', 'gu', 'telo'];
    private const NAMES = [
        'tvk' => 'Тренер в кармане',
        'gmk' => 'Где мои клиенты',
        'gu' => 'Где мои ученики',
        'telo' => 'Тело в порядке',
    ];

    public function __construct(
        private readonly PDO $state,
        private readonly Closure $readSnapshot,
        private readonly Closure $sendMessage,
    ) {
        $this->state->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->state->exec('CREATE TABLE IF NOT EXISTS payment_monitor_state (
            project TEXT PRIMARY KEY, started_at TEXT NOT NULL, cursor_at TEXT NOT NULL
        )');
        $this->state->exec('CREATE TABLE IF NOT EXISTS payment_monitor_deliveries (
            project TEXT NOT NULL, invoice_id TEXT NOT NULL, sent_at INTEGER NOT NULL,
            PRIMARY KEY (project, invoice_id)
        )');
    }

    public function initialize(DateTimeImmutable $now): void
    {
        foreach (self::PROJECTS as $project) {
            $clock = $now->setTimezone(new DateTimeZone($project === 'telo' ? 'UTC' : 'Europe/Moscow'))
                ->format('YmdHis');
            $statement = $this->state->prepare('INSERT OR IGNORE INTO payment_monitor_state
                (project, started_at, cursor_at) VALUES (?, ?, ?)');
            $statement->execute([$project, $clock, $clock]);
        }
    }

    /** @return array{status:string, payments:int, messages:int} */
    public function run(DateTimeImmutable $now): array
    {
        $moscow = $now->setTimezone(new DateTimeZone('Europe/Moscow'));
        $hour = (int) $moscow->format('G');
        if ($hour < 9 || $hour >= 21) {
            return ['status' => 'outside_hours', 'payments' => 0, 'messages' => 0];
        }

        $entries = [];
        $cursors = [];
        foreach (self::PROJECTS as $project) {
            $state = $this->state->prepare('SELECT started_at, cursor_at FROM payment_monitor_state WHERE project = ?');
            $state->execute([$project]);
            $previous = $state->fetch(PDO::FETCH_ASSOC);
            if (!is_array($previous)) {
                throw new RuntimeException('payment_state_missing');
            }
            $zone = new DateTimeZone($project === 'telo' ? 'UTC' : 'Europe/Moscow');
            $cursor = (string) $previous['cursor_at'];
            $since = max((string) $previous['started_at'], self::subtractMinutes($cursor, $zone, 2));
            $afterAt = '';
            $afterId = '';
            for ($page = 0; $page < 50; $page++) {
                $snapshot = ($this->readSnapshot)($project, $since, $afterAt, $afterId);
                self::validateSnapshot($snapshot, $project);
                $cursors[$project] = max($cursor, $snapshot['now']);
                foreach ($snapshot['rows'] as $row) {
                    $id = (string) $row['id'];
                    $query = $this->state->prepare('SELECT 1 FROM payment_monitor_deliveries
                        WHERE project = ? AND invoice_id = ?');
                    $query->execute([$project, $id]);
                    if ($query->fetchColumn() === false) {
                        $entries[] = ['project' => $project, 'id' => $id, 'row' => $row];
                    }
                }
                if (count($snapshot['rows']) < 200) {
                    break;
                }
                $last = $snapshot['rows'][199];
                $afterAt = self::compactTimestamp((string) $last['paid_at']);
                $afterId = (string) $last['id'];
                if ($page === 49) {
                    throw new RuntimeException('too_many_payment_pages');
                }
            }
        }

        $messages = 0;
        $title = $hour === 9 ? 'Утренняя сводка оплат' : 'Новые оплаты';
        foreach (self::digestChunks($title, $entries) as $chunk) {
            ($this->sendMessage)($chunk['text']);
            $this->state->beginTransaction();
            try {
                $insert = $this->state->prepare('INSERT OR IGNORE INTO payment_monitor_deliveries
                    (project, invoice_id, sent_at) VALUES (?, ?, ?)');
                foreach ($chunk['entries'] as $entry) {
                    $insert->execute([$entry['project'], $entry['id'], time()]);
                }
                $this->state->commit();
            } catch (Throwable $error) {
                $this->state->rollBack();
                throw $error;
            }
            $messages++;
        }
        $this->state->beginTransaction();
        try {
            $update = $this->state->prepare('UPDATE payment_monitor_state SET cursor_at = ? WHERE project = ?');
            foreach ($cursors as $project => $cursor) {
                $update->execute([$cursor, $project]);
            }
            $this->state->commit();
        } catch (Throwable $error) {
            $this->state->rollBack();
            throw $error;
        }
        return ['status' => 'checked', 'payments' => count($entries), 'messages' => $messages];
    }

    /** @param list<array{project:string,id:string,row:array<string,mixed>}> $entries
     *  @return list<array{text:string,entries:list<array{project:string,id:string,row:array<string,mixed>}>>>
     */
    private static function digestChunks(string $title, array $entries): array
    {
        if ($entries === []) {
            return [];
        }
        $header = '💳 <b>' . self::escape($title) . "</b>\n\n";
        $chunks = [];
        $text = $header;
        $included = [];
        foreach ($entries as $entry) {
            $line = self::paymentLine($entry['project'], $entry['row']) . "\n";
            if ($included !== [] && strlen($text . $line) > 3500) {
                $chunks[] = ['text' => rtrim($text), 'entries' => $included];
                $text = $header;
                $included = [];
            }
            $text .= $line;
            $included[] = $entry;
        }
        $chunks[] = ['text' => rtrim($text), 'entries' => $included];
        return $chunks;
    }

    /** @param array<string,mixed> $row */
    private static function paymentLine(string $project, array $row): string
    {
        $name = self::clean($row['name'] ?? null, 160)
            ?: (self::clean($row['email'] ?? null, 254)
                ?: (!empty($row['user_id']) ? 'Клиент #' . $row['user_id'] : 'Аккаунт удалён'));
        $label = self::escape($name);
        $url = self::clientLink($project, $row);
        if ($url !== null) {
            $label = '<a href="' . self::escape($url) . '">' . $label . '</a>';
        }
        $detail = $project === 'telo' && ($row['product'] ?? null) === 'renewal'
            ? 'Продление подписки'
            : ($project === 'tvk' && ($row['product'] ?? null) === 'personal_program_once'
                ? 'Индивидуальная программа' : self::clean($row['detail'] ?? null, 120));
        $amount = self::amount($project, $row['amount']);
        return '• ' . self::escape(self::NAMES[$project]) . ': ' . $label . ' — <b>' . $amount . ' ₽</b>'
            . ($detail !== '' ? ' · ' . self::escape($detail) : '')
            . (($row['status'] ?? null) === 'paid_review' ? ' · Требует проверки' : '');
    }

    /** @param array<string,mixed> $row */
    private static function clientLink(string $project, array $row): ?string
    {
        $userId = (string) ($row['user_id'] ?? '');
        if ($project === 'tvk' && preg_match('/^[1-9]\d{0,19}$/D', $userId)) {
            return 'https://trenervkarmane.ru/admin/user.php?id=' . $userId;
        }
        if ($project === 'gmk' && preg_match('/^[1-9]\d{0,19}$/D', $userId)) {
            return 'https://gdeklienty.ru/admin/trainer_account.php?id=' . $userId;
        }
        if ($project === 'telo' && preg_match('/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iD', $userId)) {
            return 'https://telovporyadke.ru/cabinet/#client/' . $userId . '/overview';
        }
        // GU has no owner-facing client card; its payment detail is optional in this digest.
        return null;
    }

    private static function amount(string $project, mixed $value): string
    {
        $source = (string) $value;
        if ($project === 'telo') {
            if (!preg_match('/^[1-9]\d{0,13}$/D', $source)) {
                throw new RuntimeException('invalid_amount');
            }
            $kopeks = (int) $source;
        } else {
            if (!preg_match('/^(?:0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/D', $source, $match)) {
                throw new RuntimeException('invalid_amount');
            }
            $kopeks = ((int) $source) * 100 + (int) str_pad($match[1] ?? '', 2, '0');
        }
        if ($kopeks <= 0) {
            throw new RuntimeException('invalid_amount');
        }
        $rubles = intdiv($kopeks, 100);
        $formatted = number_format($rubles, 0, ',', ' ');
        return $kopeks % 100 === 0 ? $formatted : $formatted . ',' . str_pad((string) ($kopeks % 100), 2, '0', STR_PAD_LEFT);
    }

    private static function escape(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    private static function clean(mixed $value, int $limit): string
    {
        $text = trim((string) preg_replace('/[\x00-\x1f\x7f]/u', ' ', (string) ($value ?? '')));
        return mb_substr($text, 0, $limit, 'UTF-8');
    }

    private static function subtractMinutes(string $value, DateTimeZone $zone, int $minutes): string
    {
        $date = DateTimeImmutable::createFromFormat('!YmdHis', $value, $zone);
        if (!$date || $date->format('YmdHis') !== $value) {
            throw new RuntimeException('invalid_cursor');
        }
        return $date->modify('-' . $minutes . ' minutes')->format('YmdHis');
    }

    private static function compactTimestamp(string $value): string
    {
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/D', $value, $m)) {
            throw new RuntimeException('invalid_paid_at');
        }
        return $m[1] . $m[2] . $m[3] . $m[4] . $m[5] . $m[6]
            . (isset($m[7]) ? str_pad($m[7], 6, '0') : '');
    }

    private static function validateSnapshot(mixed $snapshot, string $project): void
    {
        if (!is_array($snapshot) || ($snapshot['project'] ?? null) !== $project
            || !preg_match('/^\d{14}$/D', (string) ($snapshot['now'] ?? ''))
            || !isset($snapshot['rows']) || !is_array($snapshot['rows']) || count($snapshot['rows']) > 200) {
            throw new RuntimeException('snapshot_invalid');
        }
        foreach ($snapshot['rows'] as $row) {
            if (!is_array($row) || !preg_match('/^[1-9]\d{0,19}$/D', (string) ($row['id'] ?? ''))
                || !in_array($row['status'] ?? null, ['paid', 'paid_review'], true)) {
                throw new RuntimeException('snapshot_invalid_row');
            }
            self::compactTimestamp((string) ($row['paid_at'] ?? ''));
        }
    }
}

/** @return array<string,mixed> */
function readPaymentSnapshot(string $project, string $since, string $afterAt, string $afterId): array
{
    $environment = array_merge(getenv(), [
        'PAYMENT_PROJECT' => $project,
        'PAYMENT_SINCE' => $since,
        'PAYMENT_AFTER_AT' => $afterAt,
        'PAYMENT_AFTER_ID' => $afterId,
    ]);
    $process = proc_open(['/usr/bin/php', __DIR__ . '/payment-snapshot.php'],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment);
    if (!is_resource($process)) {
        throw new RuntimeException('snapshot_unavailable_' . $project);
    }
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1], 512001);
    fclose($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    if (proc_close($process) !== 0 || $output === false || strlen($output) > 512000) {
        throw new RuntimeException('snapshot_unavailable_' . $project);
    }
    try {
        return json_decode($output, true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        throw new RuntimeException('snapshot_invalid_json_' . $project);
    }
}

function sendPaymentDigest(string $token, string $ownerId, string $text): void
{
    $curl = curl_init('https://api.telegram.org/bot' . $token . '/sendMessage');
    if ($curl === false) {
        throw new RuntimeException('telegram_unavailable');
    }
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'chat_id' => $ownerId,
            'text' => $text,
            'parse_mode' => 'HTML',
            'link_preview_options' => ['is_disabled' => true],
        ], JSON_THROW_ON_ERROR),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
    ]);
    $response = curl_exec($curl);
    $status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
    curl_close($curl);
    $parsed = is_string($response) ? json_decode($response, true) : null;
    if ($status !== 200 || !is_array($parsed) || ($parsed['ok'] ?? null) !== true) {
        throw new RuntimeException('telegram_send_failed');
    }
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $mode = $argv[1] ?? '--run';
        if (!in_array($mode, ['--run', '--check', '--init'], true)) {
            throw new RuntimeException('invalid_mode');
        }
        $lock = fopen('/var/lib/codex-payment-alerts/worker.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new RuntimeException('worker_locked');
        }
        if ($mode === '--check') {
            foreach (['tvk', 'gmk', 'gu', 'telo'] as $project) {
                readPaymentSnapshot($project, '', '', '');
            }
            echo "sources_ok=4\n";
            exit(0);
        }
        $config = json_decode((string) file_get_contents('/etc/codex-payment-alerts.json'), true, 512, JSON_THROW_ON_ERROR);
        $token = (string) ($config['telegram_bot_token'] ?? '');
        $ownerId = (string) ($config['owner_chat_id'] ?? '');
        if (!preg_match('/^\d+:[A-Za-z0-9_-]+$/D', $token)
            || !preg_match('/^[1-9]\d{0,19}$/D', $ownerId)) {
            throw new RuntimeException('invalid_config');
        }
        $database = new PDO('sqlite:/var/lib/codex-payment-alerts/payment-alerts.sqlite');
        $service = new ServerPaymentAlerts($database, Closure::fromCallable('readPaymentSnapshot'),
            static fn (string $message) => sendPaymentDigest($token, $ownerId, $message));
        if ($mode === '--init') {
            $service->initialize(new DateTimeImmutable('now'));
            echo "state_initialized\n";
            exit(0);
        }
        $result = $service->run(new DateTimeImmutable('now'));
        echo $result['status'] . ' payments=' . $result['payments'] . ' messages=' . $result['messages'] . "\n";
    } catch (Throwable $error) {
        $reason = $error instanceof RuntimeException && preg_match('/^[a-z0-9_]+$/D', $error->getMessage())
            ? $error->getMessage() : 'payment_alerts_failed';
        fwrite(STDERR, $reason . "\n");
        exit(1);
    }
}
