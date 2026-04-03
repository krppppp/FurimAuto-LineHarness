-- templates.categories: JSON配列 (複数カテゴリ対応)
ALTER TABLE templates ADD COLUMN categories TEXT NOT NULL DEFAULT '[]';

-- scenario_steps の template_id から使われているテンプレートを scenario に分類
UPDATE templates
SET categories = '["scenario"]'
WHERE id IN (SELECT DISTINCT template_id FROM scenario_steps WHERE template_id IS NOT NULL);

-- automation_actions の template_id から使われているテンプレートを automation に分類
UPDATE templates
SET categories = '["automation"]'
WHERE id IN (SELECT DISTINCT template_id FROM automation_actions WHERE template_id IS NOT NULL)
  AND categories = '[]';

-- 両方で使われているテンプレートは両方のカテゴリを付与
UPDATE templates
SET categories = '["scenario","automation"]'
WHERE id IN (SELECT DISTINCT template_id FROM scenario_steps WHERE template_id IS NOT NULL)
  AND id IN (SELECT DISTINCT template_id FROM automation_actions WHERE template_id IS NOT NULL);
