-- Up Migration
-- A metrics row's label is one on its event's METRIC_LABELS list
-- (hosted/server/metric-labels.ts), held by the table as `metricLabel` holds
-- it for the writer; an event off the list is refused. A label added to the
-- list needs a migration replacing this CHECK; one dropped from it stays here
-- while rows hold it, since rows are kept forever.
ALTER TABLE dormouse_metrics_daily ADD CONSTRAINT dormouse_metrics_daily_listed CHECK (
    CASE event
        WHEN 'account.created' THEN label = ''
        WHEN 'login' THEN label IN ('email', 'github', 'google', 'microsoft', 'apple')
        WHEN 'enroll.approved' THEN label IN ('remote', 'voice')
        WHEN 'burrow.enrolled' THEN label = ''
        WHEN 'voice.speak' THEN label IN ('ok', 'capped', 'error')
        WHEN 'voice.fallback-cap' THEN label = ''
        WHEN 'push.sent' THEN label = ''
        WHEN 'pocket.signin' THEN label = ''
        WHEN 'checkout.started' THEN label IN (
            'monthly:settings-voice', 'monthly:settings-push', 'monthly:settings-remote', 'monthly:tutorial', 'monthly:home', 'monthly:pocket-playground', 'monthly:self-host', 'monthly:readme', 'monthly:hosted-no-plan', 'monthly:upsell-voice', 'monthly:upsell-push', 'monthly:other', 'monthly:none',
            'yearly:settings-voice', 'yearly:settings-push', 'yearly:settings-remote', 'yearly:tutorial', 'yearly:home', 'yearly:pocket-playground', 'yearly:self-host', 'yearly:readme', 'yearly:hosted-no-plan', 'yearly:upsell-voice', 'yearly:upsell-push', 'yearly:other', 'yearly:none',
            'founding:settings-voice', 'founding:settings-push', 'founding:settings-remote', 'founding:tutorial', 'founding:home', 'founding:pocket-playground', 'founding:self-host', 'founding:readme', 'founding:hosted-no-plan', 'founding:upsell-voice', 'founding:upsell-push', 'founding:other', 'founding:none'
        )
        WHEN 'checkout.completed' THEN label IN (
            'monthly:settings-voice', 'monthly:settings-push', 'monthly:settings-remote', 'monthly:tutorial', 'monthly:home', 'monthly:pocket-playground', 'monthly:self-host', 'monthly:readme', 'monthly:hosted-no-plan', 'monthly:upsell-voice', 'monthly:upsell-push', 'monthly:other', 'monthly:none',
            'yearly:settings-voice', 'yearly:settings-push', 'yearly:settings-remote', 'yearly:tutorial', 'yearly:home', 'yearly:pocket-playground', 'yearly:self-host', 'yearly:readme', 'yearly:hosted-no-plan', 'yearly:upsell-voice', 'yearly:upsell-push', 'yearly:other', 'yearly:none',
            'founding:settings-voice', 'founding:settings-push', 'founding:settings-remote', 'founding:tutorial', 'founding:home', 'founding:pocket-playground', 'founding:self-host', 'founding:readme', 'founding:hosted-no-plan', 'founding:upsell-voice', 'founding:upsell-push', 'founding:other', 'founding:none'
        )
        WHEN 'subscription.canceled' THEN label IN ('monthly', 'yearly', 'founding')
        WHEN 'subscription.refunded' THEN label IN ('monthly', 'yearly', 'founding')
        ELSE false
    END
);

-- Down Migration
ALTER TABLE dormouse_metrics_daily DROP CONSTRAINT dormouse_metrics_daily_listed;
