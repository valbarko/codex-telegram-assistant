<?php

declare(strict_types=1);

// Sent to the production host over SSH stdin. It performs read-only queries and
// emits only the small set of fields needed for a private owner notification.
$project = getenv('PAYMENT_PROJECT') ?: '';
$since = getenv('PAYMENT_SINCE') ?: '';
$afterAt = getenv('PAYMENT_AFTER_AT') ?: '';
$afterId = getenv('PAYMENT_AFTER_ID') ?: '';
if (!in_array($project, ['tvk', 'gmk', 'gu', 'telo'], true)
    || ($since !== '' && !preg_match('/^\d{14}$/D', $since))
    || ($afterAt !== '' && !preg_match('/^\d{14}(?:\d{6})?$/D', $afterAt))
    || ($afterId !== '' && !preg_match('/^[1-9]\d{0,19}$/D', $afterId))) {
    fwrite(STDERR, "invalid_snapshot_request\n");
    exit(2);
}

try {
    $sqlDate = static function (string $compact): string {
        return substr($compact, 0, 4) . '-' . substr($compact, 4, 2) . '-' . substr($compact, 6, 2)
            . ' ' . substr($compact, 8, 2) . ':' . substr($compact, 10, 2) . ':' . substr($compact, 12, 2)
            . (strlen($compact) === 20 ? '.' . substr($compact, 14) : '');
    };
    if ($project === 'tvk') {
        require '/srv/inyourbody/current/config/db.php';
        $db = db();
        $sql = "SELECT i.id, i.user_id, i.amount, i.paid_at, i.status,
                    TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS name,
                    u.email, p.title AS detail, p.code AS product
                  FROM tvk_billing_invoices i
                  LEFT JOIN users u ON u.id = i.user_id
                  LEFT JOIN tvk_billing_plans p ON p.id = i.plan_id
                 WHERE i.status IN ('paid', 'paid_review') AND i.paid_at >= ?";
        $timestampColumn = 'i.paid_at';
        $idColumn = 'i.id';
    } elseif ($project === 'gmk') {
        require '/srv/gmk/current/config/db.php';
        $db = db();
        $sql = "SELECT i.id, i.trainer_id AS user_id, i.amount, i.paid_at, i.status,
                    TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS name,
                    u.email, p.title AS detail, p.code AS product
                  FROM trainer_billing_invoices i
                  LEFT JOIN crm_users u ON u.id = i.trainer_id
                  LEFT JOIN trainer_billing_plans p ON p.id = i.plan_id
                 WHERE i.status IN ('paid', 'paid_review') AND i.paid_at >= ?";
        $timestampColumn = 'i.paid_at';
        $idColumn = 'i.id';
    } elseif ($project === 'gu') {
        putenv('GU_CONFIG_FILE=/srv/gdeucheniki-crm/shared/private/crm.production.json');
        require '/srv/gdeucheniki-crm/current/crm/config/db.php';
        $db = db();
        $sql = "SELECT i.id, i.tutor_id AS user_id, i.amount, i.paid_at, i.status,
                    TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS name,
                    u.email, p.title AS detail, p.code AS product
                  FROM tutor_billing_invoices i
                  LEFT JOIN crm_users u ON u.id = i.tutor_id
                  LEFT JOIN tutor_billing_plans p ON p.id = i.plan_id
                 WHERE i.status IN ('paid', 'paid_review') AND i.paid_at >= ?";
        $timestampColumn = 'i.paid_at';
        $idColumn = 'i.id';
    } else {
        require '/srv/telovporiadke/current/server/bootstrap.php';
        $db = Telo\Database::connect(Telo\Env::load('/srv/telovporiadke/shared/config/runtime.env'));
        $sql = "SELECT p.invoice_id AS id, p.user_id, p.amount_kopecks AS amount,
                    p.status,
                    p.confirmed_at AS paid_at,
                    TRIM(CONCAT_WS(' ', u.name, u.last_name)) AS name,
                    u.email, p.plan_id AS detail, p.kind AS product
                  FROM billing_payments p
                  LEFT JOIN users u ON u.id = p.user_id
                 WHERE p.status = 'paid' AND p.kind IN ('initial', 'renewal')
                   AND p.confirmed_at >= ?";
        $timestampColumn = 'p.confirmed_at';
        $idColumn = 'p.invoice_id';
    }

    $db->exec('SET TRANSACTION READ ONLY');
    $db->beginTransaction();
    $now = (string) $db->query("SELECT DATE_FORMAT(NOW(6), '%Y%m%d%H%i%s')")->fetchColumn();
    if ($since === '') {
        $rows = [];
    } else {
        $parameters = [$sqlDate($since)];
        if ($afterAt !== '') {
            $sql .= " AND ($timestampColumn > ? OR ($timestampColumn = ? AND $idColumn > ?))";
            $after = $sqlDate($afterAt);
            array_push($parameters, $after, $after, $afterId);
        }
        $sql .= " ORDER BY $timestampColumn, $idColumn LIMIT 200";
        $statement = $db->prepare($sql);
        $statement->execute($parameters);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
    }
    $db->commit();
    echo json_encode(['project' => $project, 'now' => $now, 'rows' => $rows], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    if (isset($db) && $db->inTransaction()) {
        $db->rollBack();
    }
    // No SQL, credentials, names, or raw provider errors in SSH output.
    fwrite(STDERR, "payment_snapshot_unavailable\n");
    exit(1);
}
