/**
 * オートメーション一括登録スクリプト
 * Usage:
 *   node scripts/seed-automations.mjs          # dev
 *   node scripts/seed-automations.mjs --prod   # prod
 */

import { execSync } from 'child_process';

const isProd = process.argv.includes('--prod');
const isRebase = process.argv.includes('--rebase');
const friendAddOnly = process.argv.includes('--friend-add-only');
const cancelOnly = process.argv.includes('--cancel-only');
const DB_NAME = isProd ? 'line-crm-prod' : isRebase ? 'line-crm-rebase' : 'line-crm';
const CWD = new URL('../apps/worker', import.meta.url).pathname;
console.log(`[seed-automations] DB: ${DB_NAME} (${isProd ? 'PROD' : 'DEV'})\n`);

function runSQL(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}'`, { stdio: 'pipe', cwd: CWD });
  } catch (e) {
    const msg = e.stderr?.toString() ?? e.message;
    if (msg.includes('UNIQUE constraint') || msg.includes('already exists')) {
      process.stdout.write(' [skip]');
    } else {
      console.error('\n  [error]', msg.slice(0, 300));
    }
  }
}

function jstNow() {
  return new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function insertAutomation({ id, name, description, eventType, priority = 0 }) {
  const now = jstNow();
  process.stdout.write(`  automation: ${name}...`);
  runSQL(`INSERT OR IGNORE INTO automations (id, name, description, event_type, conditions, actions, is_active, priority, created_at, updated_at) VALUES ('${id}', '${name.replace(/'/g,"''")}', '${description.replace(/'/g,"''")}', '${eventType}', '{}', '[]', 1, ${priority}, '${now}', '${now}');`);
  console.log();
}

// 名前で既存automationを引き、あればstep全削除して再利用、なければ新規作成（再実行冪等）
function getOrCreateAutomation({ name, description, eventType, priority = 0 }) {
  const res = JSON.parse(
    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command "SELECT id FROM automations WHERE name = '${name.replace(/'/g, "''")}' LIMIT 1;" --json`, { cwd: CWD }).toString()
  );
  const existingId = res[0]?.results?.[0]?.id;
  if (existingId) {
    runSQL(`DELETE FROM automation_actions WHERE automation_id = '${existingId}';`);
    console.log(`  automation: ${name} (既存 ${existingId} のstepを再構成)`);
    return existingId;
  }
  const id = crypto.randomUUID();
  insertAutomation({ id, name, description, eventType, priority });
  return id;
}

let _actionCounter = 0;
function insertAction({ automationId, stepOrder, actionType, params, conditionJson = null, label = null, isActive = 1 }) {
  const id = crypto.randomUUID();
  const now = jstNow();
  const paramsJson = JSON.stringify(params).replace(/'/g, "''");
  const condVal = conditionJson ? `'${JSON.stringify(conditionJson).replace(/'/g,"''")}'` : 'NULL';
  const labelVal = label ? `'${String(label).replace(/'/g,"''")}'` : 'NULL';
  process.stdout.write(`    step${stepOrder}: ${actionType}${label ? ' / '+label : ''}...`);
  runSQL(`INSERT INTO automation_actions (id, automation_id, step_order, action_type, params, condition_json, on_error, is_active, label, created_at, updated_at) VALUES ('${id}', '${automationId}', ${stepOrder}, '${actionType}', '${paramsJson}', ${condVal}, 'continue', ${isActive}, ${labelVal}, '${now}', '${now}');`);
  console.log();
  _actionCounter++;
}

// ────────────────────────────────────────────────────────────────────
// メッセージ定数
// ────────────────────────────────────────────────────────────────────

const WELCOME_FLEX_VIDEO = JSON.stringify({
  type: 'bubble',
  hero: { type: 'image', url: 'https://img.youtube.com/vi/uQjheVeAuww/maxresdefault.jpg', size: 'full', aspectRatio: '16:9', aspectMode: 'cover', action: { type: 'uri', uri: 'https://www.youtube.com/watch?v=uQjheVeAuww' } },
  body: { type: 'box', layout: 'vertical', contents: [
    { type: 'text', text: 'FurimAuto紹介動画', weight: 'bold', size: 'xl', wrap: true },
    { type: 'text', text: '1番初めに見るべき動画はコレ👆👆👆\n\n長ったらしい説明はナシ！です🙅‍♀️\n\nFurimAutoの使い方と\n他者ツールと比べた特徴を\n1分でまとめました!!\n\n断言しますが\nこのツールより簡単で\n全局面での自動化を実現した\n自動化ツールはこの世にはないです🤫', size: 'sm', color: '#666666', margin: 'md', wrap: true },
  ]},
  footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: 'YouTubeで見る', uri: 'https://www.youtube.com/watch?v=uQjheVeAuww' }, color: '#FF0000' }] },
});

const TOKUTEN_FLEX = JSON.stringify({
  type: 'bubble',
  hero: { type: 'image', url: 'https://furimauto.com/service/images/special_offer.png', size: 'full', aspectRatio: '1:1', aspectMode: 'cover' },
  body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
    { type: 'text', text: '🎁 無料期間中に15大特典をGETしよう！', weight: 'bold', size: 'lg', wrap: true, color: '#FF6B35' },
    { type: 'text', text: '友達登録から1週間の無料試用期間中に、段階的に15種類の特典をプレゼントします！', size: 'sm', color: '#555555', wrap: true, margin: 'sm' },
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs', contents: [
      { type: 'text', text: '📦 今すぐもらえる特典', weight: 'bold', size: 'sm', color: '#333333' },
      { type: 'button', style: 'link', height: 'sm', margin: 'xs', action: { type: 'uri', label: '① ロードマップ❶ ダウンロード', uri: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B81%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B6.pdf' } },
      { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '② ロードマップ❷ ダウンロード', uri: 'https://storage.googleapis.com/furimauto_line/tokuten/%E7%89%B9%E5%85%B82%E3%83%AD%E3%83%BC%E3%83%88%E3%82%99%E3%83%9E%E3%83%83%E3%83%95%E3%82%9A%E2%9D%B7.pdf' } },
    ]},
    { type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs', contents: [
      { type: 'text', text: '🔓 使うほどもらえる特典（リッチメニューから）', weight: 'bold', size: 'sm', color: '#333333', wrap: true },
      ...['③ ロードマップ❸','④ ロードマップ❹','⑤ 撮影方法マニュアル前編','⑥ 撮影方法マニュアル後編','⑦ 外注化マニュアル前編','⑧ 外注化マニュアル後編','⑨ 外注募集テンプレート','⑩ 外注先業務委託契約書テンプレ','⑪ コメントセールの手法と効果の解説','⑫ 売れるブランドリスト','⑬ 売れるアカウント説明&プロフィール解説'].map(t => ({ type: 'text', text: t, size: 'sm', color: '#444444', margin: 'xs', wrap: true })),
    ]},
    { type: 'box', layout: 'vertical', margin: 'md', spacing: 'xs', contents: [
      { type: 'text', text: '🎬 YouTubeを視聴の上キーワード入力でもらえる特典', weight: 'bold', size: 'sm', color: '#333333', wrap: true },
      { type: 'text', text: '⑭ 初月半額クーポン', size: 'sm', color: '#444444', margin: 'xs' },
      { type: 'text', text: '⑮ 無料試用期間1週間延長', size: 'sm', color: '#444444' },
    ]},
    { type: 'separator', margin: 'md' },
    { type: 'text', text: 'リッチメニューの「限定特典GET」をタップすると、あなたの利用状況に応じて次の特典が届きます！', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
  ]},
});

const SURVEY_FLEX = JSON.stringify({
  type: 'bubble',
  hero: { type: 'image', url: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/follow_event_img3.png', size: 'full', aspectRatio: '16:9', aspectMode: 'cover' },
  body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '▼ 1問アンケートはこちら ▼', weight: 'bold', size: 'lg', wrap: true, align: 'center' }] },
  footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'button', style: 'primary', height: 'sm', action: { type: 'message', label: '開始する', text: '【ボタン】アンケート開始' } }] },
});

// キーコードは自動で送らない（くろさん方針2026-07-08: リッチメニューの発行ボタンを
// ユーザー自身に押させることがエンゲージメントのきっかけになるため）。トライアル全機能化の訴求のみ反映
const WELCOME_TEXT = '/／\n🗣 友達登録ありがとうございます！\n\\＼\n╭△━━━━━━━━━━━━━━━╮\nたった今から、\n全機能が使い放題の\n1週間無料試用期間が\n開始となります！🎉\n╰━━━━━━━━━━━━━━━━╯\n\nFurimAuto(フリマート)は\nメルカリを中心に、\nそのフリマサイト上で自動化を実現する\nChrome拡張機能型ツールです！💻\n\n---------------------------------------------------\n\n◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢\n\n👆どんな使い方をするのか、\n👆サクッと基本を知るには\n👆上の動画\n\n👇1週間の無料期間での\n👇ベストな使い方を知るには\n👇下の動画\n\n◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢◤◢';

// 解約理由アンケート（1タップ回答→button-actions.tsの「解約理由:」ハンドラが受ける）
const CANCEL_SURVEY_FLEX = JSON.stringify({
  type: 'bubble',
  size: 'mega',
  body: { type: 'box', layout: 'vertical', contents: [
    { type: 'text', text: '最後に1つだけ教えてください🙇', weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: '今回解約された1番の理由はどれですか？\n（1タップで完了します）', size: 'md', wrap: true, margin: 'md' },
  ]},
  footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
    { type: 'button', style: 'primary', height: 'sm', action: { type: 'message', label: '料金が高かった', text: '【ボタン】解約理由:料金が高い' } },
    { type: 'button', style: 'primary', height: 'sm', action: { type: 'message', label: '使いこなせなかった', text: '【ボタン】解約理由:使いこなせなかった' } },
    { type: 'button', style: 'primary', height: 'sm', action: { type: 'message', label: '思うような成果が出なかった', text: '【ボタン】解約理由:成果が出なかった' } },
    { type: 'button', style: 'primary', height: 'sm', action: { type: 'message', label: '物販をやめた・お休みする', text: '【ボタン】解約理由:物販休止' } },
    { type: 'button', style: 'primary', height: 'sm', action: { type: 'message', label: '他のツールに乗り換えた', text: '【ボタン】解約理由:他ツールへ乗り換え' } },
    { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: 'その他', text: '【ボタン】解約理由:その他' } },
  ]},
});

// ── 1. friend_add 既存オートメーション ─────────────────────────────────────────────

if (!cancelOnly) {

console.log('[1] friend_add: ウェルカム/リフォローアクション追加');

const friendAddResult = JSON.parse(
  execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command "SELECT id FROM automations WHERE event_type = 'friend_add' LIMIT 1;" --json`, { cwd: CWD }).toString()
);
const friendAddId = friendAddResult[0]?.results?.[0]?.id;

if (friendAddId) {
  console.log(`  id: ${friendAddId}`);
  // 全step を一旦削除して再挿入（friend_add フローはこのseedが完全所有）
  runSQL(`DELETE FROM automation_actions WHERE automation_id = '${friendAddId}';`);
  console.log('  deleted all steps');

  // ── 新規登録時の顧客登録（CloudFunctions eventFollow 相当） ──
  // step0: Stripe顧客作成（stripeCustomerId を friend.metadata に保存）
  insertAction({ automationId: friendAddId, stepOrder: 0, actionType: 'create_stripe_customer', label: 'Stripe顧客作成', conditionJson: { isNewUser: true }, params: { save_to_metadata: 'stripeCustomerId' } });
  // step1: GAS setCustomerData（スプレッドシートに新規顧客レコード作成）
  insertAction({ automationId: friendAddId, stepOrder: 1, actionType: 'call_gas_post', label: 'GAS setCustomerData', conditionJson: { isNewUser: true }, params: { method: 'setCustomerData', args: {
    followEventDateTime: '{{now_jst}}',
    lineUserDisplayName: '{{display_name}}',
    lineUserId: '{{line_user_id}}',
    stripeCustomerId: '{{stripe_customer_id}}',
    trialFinishedDateTime: '{{trial_end_jst}}',
  } } });
  // step2: 無料試用期間中タグ付与
  insertAction({ automationId: friendAddId, stepOrder: 2, actionType: 'add_tag_by_name', label: '無料試用期間中タグ付与', conditionJson: { isNewUser: true }, params: { tagName: '無料試用期間中' } });
  // ※キーコードの自動お届けは実施しない（くろさん方針2026-07-08: 発行ボタンをユーザーに
  //   押させる）。トライアル全機能化はプラン一覧「友達登録1週間トライアルプラン」行の
  //   全機能化（実施済み）によりsetCustomerData内のsetKeyCode転写で実現される

  insertAction({ automationId: friendAddId, stepOrder: 7, actionType: 'send_messages', label: 'ウェルカム5通送信', conditionJson: { isNewUser: true }, params: { messages: [
    { messageType: 'flex', altText: 'FurimAuto紹介動画', content: WELCOME_FLEX_VIDEO },
    { messageType: 'text', content: WELCOME_TEXT },
    { messageType: 'video', content: JSON.stringify({ originalContentUrl: 'https://storage.googleapis.com/furimauto_line/video/meet.mp4', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/video/install_thumnail.png', trackingId: 'setup' }) },
    { messageType: 'flex', altText: '🎁 無料期間中に15大特典をGETしよう！', content: TOKUTEN_FLEX },
    { messageType: 'flex', altText: '【無料お試し期間が始まりました！】', content: SURVEY_FLEX },
  ]}});

  insertAction({ automationId: friendAddId, stepOrder: 8, actionType: 'send_messages', label: 'リフォロー返信', conditionJson: { isNewUser: false }, params: { messages: [
    { messageType: 'text', content: '以前に友達登録されていらしたかと思いますので、キーコード無料利用期間の対象外になってしまっておりますm(_ _)m\n\nが、是非是非使っていただきたいのでもしご興味があれば"無料で試してみたい"と一言ください！' },
  ]}});

  insertAction({ automationId: friendAddId, stepOrder: 9, actionType: 'code_managed', label: '[code] リフォロー時キーコード確認→会員リッチメニュー', conditionJson: { isNewUser: false }, params: { description: 'GAS getKeyCode で有効期限確認 → 期限内なら RICHMENU_MEMBER_HOME を設定' }, isActive: 0 });
} else {
  console.error('  [error] friend_add automation not found');
}

if (friendAddOnly) {
  console.log(`\n✅ 完了(friend-add-only): ${_actionCounter}アクション登録`);
  process.exit(0);
}

// ── 2. unfollow ──────────────────────────────────────────────────────────────────────

console.log('\n[2] ブロック時フロー (unfollow)');
const unfollowId = getOrCreateAutomation({ name: 'ブロック時フロー', description: 'ブロック時: ブロックタグ付与・無料試用期間中タグ削除', eventType: 'unfollow', priority: 0 });
insertAction({ automationId: unfollowId, stepOrder: 0, actionType: 'add_tag_by_name', label: 'ブロックタグ付与', params: { tagName: 'ブロック' } });
insertAction({ automationId: unfollowId, stepOrder: 1, actionType: 'remove_tag_by_name', label: '無料試用期間中タグ削除', params: { tagName: '無料試用期間中' } });

// ── 3. stripe_invoice_paid — 新規月額登録 ───────────────────────────────────────────

console.log('\n[3] 月額新規登録フロー (stripe_invoice_paid, isNewSubscription=true)');
const invoiceNewId = getOrCreateAutomation({ name: '月額新規登録フロー', description: '新規月額登録: GAS登録・タグ整理・メッセージ送信', eventType: 'stripe_invoice_paid', priority: 10 });

const GAS_INVOICE_ARGS = { stripeCustomerID: '{{eventData.stripeCustomerId}}', planName: '{{eventData.planName}}', subscriptionID: '{{eventData.subscriptionId}}', subscriptionStartDateTime: '{{eventData.subscriptionStartDateTime}}', subscriptionEndDateTime: '{{eventData.subscriptionEndDateTime}}', subscriptionPrice: '{{eventData.planAmount}}', subscriptionActualPaidAmount: '{{eventData.actualPaidAmount}}', customerEmail: '{{eventData.customerEmail}}' };
const GAS_TX_ARGS = { stripeCustomerID: '{{eventData.stripeCustomerId}}', invoiceID: '{{eventData.invoiceId}}', planName: '{{eventData.planName}}', subscriptionPrice: '{{eventData.planAmount}}', discountAmount: '{{eventData.discountAmount}}', priceExclTax: '{{eventData.priceExclTax}}', taxAmount: '{{eventData.taxAmount}}', actualPaidAmount: '{{eventData.actualPaidAmount}}' };

insertAction({ automationId: invoiceNewId, stepOrder: 0, actionType: 'call_gas_post', label: 'GAS setSubscriptionData', conditionJson: { isNewSubscription: true }, params: { method: 'setSubscriptionData', args: GAS_INVOICE_ARGS } });
// setKeyCodeは旧プラン一覧ベースのみ（plan-builderはstripe.tsのsyncFeaturesFromSubscriptionで完結。
// planName空/PBプラン:でプラン一覧を誤マッチするとキーコード・フラグを破壊するため必ず除外）
insertAction({ automationId: invoiceNewId, stepOrder: 1, actionType: 'call_gas_post', label: 'GAS setKeyCode (旧プランのみ)', conditionJson: { isNewSubscription: true, isLegacyPlan: true }, params: { method: 'setKeyCode', args: { planName: '{{eventData.planName}}', stripeCustomerID: '{{eventData.stripeCustomerId}}' } } });
insertAction({ automationId: invoiceNewId, stepOrder: 2, actionType: 'call_gas_post', label: 'GAS setTransactionData', conditionJson: { isNewSubscription: true }, params: { method: 'setTransactionData', args: GAS_TX_ARGS } });
insertAction({ automationId: invoiceNewId, stepOrder: 3, actionType: 'code_managed', label: '[code] 会員リッチメニュー切替 (RICHMENU_MEMBER_HOME)', conditionJson: { isNewSubscription: true }, params: { description: 'env.RICHMENU_MEMBER_HOME を linkRichMenuToUser で設定' }, isActive: 0 });
insertAction({ automationId: invoiceNewId, stepOrder: 4, actionType: 'add_tag_by_name', label: '月額会員タグ付与', conditionJson: { isNewSubscription: true }, params: { tagName: '月額会員' } });
insertAction({ automationId: invoiceNewId, stepOrder: 5, actionType: 'add_tag_by_name', label: '金額タグ付与 (月額{{eventData.planTier}})', conditionJson: { isNewSubscription: true }, params: { tagName: '月額{{eventData.planTier}}' } });

const removableTagsNew = ['セグメント1','セグメント2','セグメント3','セグメント4','セグメント5','セグメント6','セグメント7','セグメント8','無料試用期間中','解説見た','Furimanです','キャンセル済み'];
removableTagsNew.forEach((tagName, i) => {
  insertAction({ automationId: invoiceNewId, stepOrder: 6 + i, actionType: 'remove_tag_by_name', label: `${tagName}タグ削除`, conditionJson: { isNewSubscription: true }, params: { tagName } });
});

const nextStep = 6 + removableTagsNew.length;
insertAction({ automationId: invoiceNewId, stepOrder: nextStep, actionType: 'complete_active_scenarios', label: 'アクティブシナリオ完了', conditionJson: { isNewSubscription: true }, params: {} });
const AMBASSADOR_IMAGE = { messageType: 'image', content: JSON.stringify({ originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/ambassador.png' }) };
const AMBASSADOR_TEXT = { messageType: 'text', content: '【アンバサダー制度でお得にご利用いただけます💡】\n      \n「FurimAutoオススメだよ!!」\nとお友達にご紹介していただけましたら\n双方にとって絶対にお得なプログラムとなっております✨\n\nご興味ございましたらリッチメニューの\nアンバサダー制度\nをタップしてください😆\n\nFurimAutoが皆様の物販事業\n底上げに繋がるように\n引き続き開発を続けて参りますので、\nどうぞ末長くよろしくお願いいたします。' };
// 旧プラン: キーコードが再発行されるため再入力が必要
insertAction({ automationId: invoiceNewId, stepOrder: nextStep + 1, actionType: 'send_messages', label: '新規登録メッセージ3通 (旧プラン)', conditionJson: { isNewSubscription: true, isLegacyPlan: true }, params: { messages: [
  { messageType: 'text', content: '【自動送信】\n月額プランへのご登録ありがとうございました🌟\nまた、それに伴いましてお客様のキーコードが更新されましたので、お手数ですがリッチメニューから新しいキーコードを発行の上、拡張機能に再入力してください。\n\n引き続き仕様変更への迅速な対応、ユーザー様の声をできる限り汲んで運営してまいりますので\nよろしくお願いいたします。' },
  AMBASSADOR_IMAGE,
  AMBASSADOR_TEXT,
]}});
// plan-builder新規登録: 新規サブスク(isNewSubscription)は有効な有料キーコードを持たない状態
// からの登録（トライアル移行・完全新規・再登録いずれも）のため、キーコードは必ず刷新される。
// cron再処理をまたぐとsyncのkeyCodeIssuedは冪等でfalseに反転し、揮発的なその値で分岐すると
// 「不要」誤配信や両方配信が起きるため、再処理をまたいでも安定するisNewSubscription+PB条件で
// 「再入力必要」に固定する。
insertAction({ automationId: invoiceNewId, stepOrder: nextStep + 2, actionType: 'send_messages', label: '新規登録メッセージ3通 (plan-builder)', conditionJson: { isNewSubscription: true, isLegacyPlan: false }, params: { messages: [
  { messageType: 'text', content: '【自動送信】\n月額プランへのご登録ありがとうございました🌟\nまた、それに伴いましてお客様のキーコードが更新されましたので、お手数ですがリッチメニューのホームタブ「キーコード発行」から新しいキーコードを発行の上、拡張機能に再入力してください。\n\n引き続き仕様変更への迅速な対応、ユーザー様の声をできる限り汲んで運営してまいりますので\nよろしくお願いいたします。' },
  AMBASSADOR_IMAGE,
  AMBASSADOR_TEXT,
]}});

// ── 4. stripe_invoice_paid — 継続課金 ───────────────────────────────────────────────

console.log('\n[4] 月額継続課金フロー (stripe_invoice_paid, isNewSubscription=false)');
const invoiceRenewId = getOrCreateAutomation({ name: '月額継続課金フロー', description: '継続課金: GAS更新・タグ整理・アンバサダークーポン・メッセージ送信', eventType: 'stripe_invoice_paid', priority: 5 });

insertAction({ automationId: invoiceRenewId, stepOrder: 0, actionType: 'call_gas_post', label: 'GAS setSubscriptionData', conditionJson: { isNewSubscription: false }, params: { method: 'setSubscriptionData', args: GAS_INVOICE_ARGS } });
insertAction({ automationId: invoiceRenewId, stepOrder: 1, actionType: 'call_gas_post', label: 'GAS setKeyCode (旧プランのみ)', conditionJson: { isNewSubscription: false, isLegacyPlan: true }, params: { method: 'setKeyCode', args: { planName: '{{eventData.planName}}', stripeCustomerID: '{{eventData.stripeCustomerId}}' } } });
insertAction({ automationId: invoiceRenewId, stepOrder: 2, actionType: 'call_gas_post', label: 'GAS setTransactionData', conditionJson: { isNewSubscription: false }, params: { method: 'setTransactionData', args: GAS_TX_ARGS } });
insertAction({ automationId: invoiceRenewId, stepOrder: 3, actionType: 'add_tag_by_name', label: '月額会員タグ付与', conditionJson: { isNewSubscription: false }, params: { tagName: '月額会員' } });
insertAction({ automationId: invoiceRenewId, stepOrder: 4, actionType: 'add_tag_by_name', label: '金額タグ付与 (月額{{eventData.planTier}})', conditionJson: { isNewSubscription: false }, params: { tagName: '月額{{eventData.planTier}}' } });
insertAction({ automationId: invoiceRenewId, stepOrder: 5, actionType: 'code_managed', label: '[code] アンバサダークーポン適用', conditionJson: { isNewSubscription: false }, params: { description: 'GAS updateIntroductionCoupon → ambassadorCouponId があれば Stripe API でクーポン適用（stripe.tsのコードで実行済み）' }, isActive: 0 });
const COUPON_IMAGE = { messageType: 'image', content: JSON.stringify({ originalContentUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/coupon_get.png', previewImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/coupon_get.png' }) };
const COUPON_TEXT = { messageType: 'text', content: '【割引告知】\nお客様のご利用にあたり、\n次回の継続課金の際に適用可能な割引クーポンのご案内です💰\n\n詳しくはリッチメニューの\n1️⃣ガイドタブ\n2️⃣クーポンGET\nを順番にタップしてご確認ください🎆' };
insertAction({ automationId: invoiceRenewId, stepOrder: 6, actionType: 'send_messages', label: '継続課金メッセージ+割引告知 (旧プラン)', conditionJson: { isNewSubscription: false, isLegacyPlan: true }, params: { messages: [
  { messageType: 'text', content: '【自動送信】\nご登録いただいております月額プランへの継続課金成功のお知らせをお知らせいたします。\n内容のご確認をご希望のお客様は、メニュー下部の"会員情報の確認"クリックしてご確認してください。\n\nまた、それに伴いましてお客様のキーコードが更新されましたので、お手数ですがリッチメニューから新しいキーコードを発行の上、ブラウザにて再入力してください。\n\nそれでは、これからもFurimAutoを存分に活用してください♪' },
  COUPON_IMAGE,
  COUPON_TEXT,
]}});
insertAction({ automationId: invoiceRenewId, stepOrder: 7, actionType: 'send_messages', label: '継続課金メッセージ+割引告知 (plan-builder)', conditionJson: { isNewSubscription: false, isLegacyPlan: false }, params: { messages: [
  { messageType: 'text', content: '【自動送信】\nご登録いただいております月額プランへの継続課金成功のお知らせです。\n内容のご確認をご希望のお客様は、メニュー下部の"会員情報の確認"をクリックしてご確認ください。\n\nキーコード・機能はそのまま継続してお使いいただけます（再入力は不要です）。\n\nそれでは、これからもFurimAutoを存分に活用してください♪' },
  COUPON_IMAGE,
  COUPON_TEXT,
]}});

} // !cancelOnly

// ── 5. stripe_subscription_deleted ──────────────────────────────────────────────────

console.log('\n[5] 月額解約フロー (stripe_subscription_deleted)');
const subDeletedId = getOrCreateAutomation({ name: '月額解約フロー', description: '解約: GAS解約処理・タグ整理・解約通知', eventType: 'stripe_subscription_deleted', priority: 0 });

insertAction({ automationId: subDeletedId, stepOrder: 0, actionType: 'call_gas_post', label: 'GAS deleteSubscription', params: { method: 'deleteSubscription', args: { stripeCustomerID: '{{eventData.stripeCustomerId}}', subscriptionID: '{{eventData.subscriptionId}}' } } });
insertAction({ automationId: subDeletedId, stepOrder: 1, actionType: 'code_managed', label: '[code] デフォルトリッチメニュー切替 (RICHMENU_DEFAULT_HOME)', params: { description: 'env.RICHMENU_DEFAULT_HOME を linkRichMenuToUser で設定' }, isActive: 0 });
insertAction({ automationId: subDeletedId, stepOrder: 2, actionType: 'add_tag_by_name', label: 'キャンセル済みタグ付与', params: { tagName: 'キャンセル済み' } });

const cancelRemoveTags = ['月額会員','月額3000','月額5000','月額8000','月額10000','月額15000','月額19800','無料試用期間中'];
cancelRemoveTags.forEach((tagName, i) => {
  insertAction({ automationId: subDeletedId, stepOrder: 3 + i, actionType: 'remove_tag_by_name', label: `${tagName}タグ削除`, params: { tagName } });
});

insertAction({ automationId: subDeletedId, stepOrder: 3 + cancelRemoveTags.length, actionType: 'send_messages', label: '解約通知メッセージ+理由アンケート', params: { messages: [
  { messageType: 'text', content: '【自動送信】\nご登録いただいておりました月額プランを解消しました。\n現時点でキーコードは使用不可となります。\n\nFurimAutoでは日々開発を進め今後も機能面はもちろん、利用可能になるプラットフォームを広げていきますので、またの機会がございましたら再度と月額プラン登録の手順を踏んでください。\n\nまたのご利用をお待ちしております！' },
  { messageType: 'flex', altText: '【1タップ】解約理由アンケート', content: CANCEL_SURVEY_FLEX },
]}});

// ── 6. stripe_payment_failed ──────────────────────────────────────────────────────────

if (!cancelOnly) {

console.log('\n[6] 支払い失敗フロー (stripe_payment_failed)');
const payFailedId = getOrCreateAutomation({ name: '支払い失敗フロー', description: '初回支払い失敗時: LINEで支払い方法確認を依頼', eventType: 'stripe_payment_failed', priority: 0 });
insertAction({ automationId: payFailedId, stepOrder: 0, actionType: 'send_messages', label: '支払い失敗通知', params: { messages: [
  { messageType: 'text', content: '【自動送信】\nお客様の月額プランへのお支払いが確認できませんでした。\n\nリッチメニューのホームタブ「月額会員ページ」から、お支払い方法のご確認・変更をお願いいたします。\n\nお支払いが確認できない場合、サービスのご利用ができなくなる場合がございます。' },
]}});

// ── 7. stripe_ticket_purchased ────────────────────────────────────────────────────────

console.log('\n[7] チケット購入フロー (stripe_ticket_purchased)');
const ticketId = getOrCreateAutomation({ name: 'チケット購入フロー', description: 'コピー出品チケット購入完了: GAS登録・購入完了メッセージ', eventType: 'stripe_ticket_purchased', priority: 0 });
insertAction({ automationId: ticketId, stepOrder: 0, actionType: 'call_gas_post', label: 'GAS setTicketTransaction', params: { method: 'setTicketTransaction', args: { lineUserId: '{{line_user_id}}', ticketCount: '{{eventData.quantity}}', paymentIntentId: '{{eventData.paymentIntentId}}', amount: '{{eventData.amount}}', currency: '{{eventData.currency}}' } } });
insertAction({ automationId: ticketId, stepOrder: 1, actionType: 'send_messages', label: 'チケット購入完了メッセージ', params: { messages: [
  { messageType: 'text', content: '🎉【チケット購入完了】🎉\n\nコピー出品チケット {{eventData.quantity}}枚の購入が完了しました！\n\nキーコードの入力ボタンを押して、チケット枚数を取得してください。\nFurimAutoのコピー出品機能でご利用いただけます。\n\n引き続きFurimAutoをよろしくお願いします。' },
]}});

} // !cancelOnly

console.log(`\n✅ 完了: ${_actionCounter}アクション登録`);
