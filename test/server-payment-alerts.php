<?php

declare(strict_types=1);

require __DIR__ . '/../scripts/server-payment-alerts.php';

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$now = new DateTimeImmutable('2026-09-30 09:00:00', new DateTimeZone('Europe/Moscow'));
$database = new PDO('sqlite::memory:');
$reads = 0;
$messages = [];
$fail = false;
$rows = [
    'tvk' => [[
        'id' => 42, 'user_id' => 17, 'amount' => '990.00', 'paid_at' => '2026-09-29 22:10:00',
        'status' => 'paid', 'name' => 'Анна <Б>', 'email' => null,
        'detail' => 'Подписка & доступ', 'product' => 'basic_monthly',
    ]],
    'gu' => [[
        'id' => 21, 'user_id' => 8, 'amount' => '1500.00', 'paid_at' => '2026-09-30 01:30:00',
        'status' => 'paid_review', 'name' => 'Иван', 'email' => null,
        'detail' => 'Доступ', 'product' => 'month',
    ]],
];
$reader = static function (string $project, string $since) use (&$reads, &$rows): array {
    $reads++;
    $projectRows = array_values(array_filter($rows[$project] ?? [],
        static fn (array $row): bool => str_replace(['-', ' ', ':'], '', $row['paid_at']) >= $since));
    return ['project' => $project, 'now' => $project === 'telo' ? '20260930060000' : '20260930090000',
        'rows' => $projectRows];
};
$sender = static function (string $text) use (&$messages, &$fail): void {
    if ($fail) {
        throw new RuntimeException('telegram_send_failed');
    }
    $messages[] = $text;
};
$service = new ServerPaymentAlerts($database, $reader(...), $sender(...));
$service->initialize(new DateTimeImmutable('2026-09-29 20:00:00', new DateTimeZone('Europe/Moscow')));

check($service->run(new DateTimeImmutable('2026-09-29 21:00:00', new DateTimeZone('Europe/Moscow')))['status']
    === 'outside_hours', 'night run must be skipped');
check($reads === 0, 'night run must not read payment databases');

$fail = true;
try {
    $service->run($now);
    throw new RuntimeException('failed send should throw');
} catch (RuntimeException $error) {
    check($error->getMessage() === 'telegram_send_failed', 'unexpected send failure');
}
check($database->query('SELECT COUNT(*) FROM payment_monitor_deliveries')->fetchColumn() === 0,
    'failed send must not mark invoices delivered');

$fail = false;
$result = $service->run($now);
check($result === ['status' => 'checked', 'payments' => 2, 'messages' => 1], 'morning digest result');
check(count($messages) === 1 && str_contains($messages[0], 'Утренняя сводка оплат'), 'single morning digest');
check(str_contains($messages[0], 'Анна &lt;Б&gt;') && str_contains($messages[0], 'Подписка &amp; доступ'),
    'personal fields must be escaped');
check(str_contains($messages[0], 'https://trenervkarmane.ru/admin/user.php?id=17'), 'client card link');
check(str_contains($messages[0], 'Требует проверки') && !str_contains($messages[0], 'platform_invoice_id'),
    'review status without mandatory payment link');
check($service->run($now)['payments'] === 0 && count($messages) === 1, 'invoice deduplication');

$rows['gmk'] = [[
    'id' => 77, 'user_id' => 10, 'amount' => '1990.50', 'paid_at' => '2026-09-30 09:30:00',
    'status' => 'paid', 'name' => 'Пётр', 'email' => null, 'detail' => null, 'product' => null,
]];
$result = $service->run(new DateTimeImmutable('2026-09-30 10:00:00', new DateTimeZone('Europe/Moscow')));
check($result['payments'] === 1 && count($messages) === 2, 'next hourly digest');
check(str_contains($messages[1], '1 990,50 ₽'), 'kopeks must be formatted exactly');
echo "server_payment_alerts_ok\n";
