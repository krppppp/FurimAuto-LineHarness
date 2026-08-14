// CF handleRichMenuAction.ts から移植したメッセージオブジェクト

export const carouselTemplate = {
  type: 'template',
  altText: '機能別解説カルーセル',
  template: {
    type: 'carousel',
    columns: [
      {
        thumbnailImageUrl: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/price_table.jpeg',
        title: '料金表',
        text: '機能別単品料金表とプラン表を紹介します',
        actions: [
          { type: 'message', label: '概要', text: '【ボタン】概要(料金表)' },
          { type: 'message', label: 'ビュッフェ式(機能別料金表)', text: '【ボタン】ビュッフェ式料金表(料金表)' },
          { type: 'message', label: 'パッケージプラン', text: '【ボタン】パッケージプラン(料金表)' },
        ],
      },
      {
        thumbnailImageUrl: 'https://example.com/bot/images/item2.jpg',
        title: 'ワンバイワン機能①',
        text: 'デイリーオプション',
        actions: [
          { type: 'message', label: '値段変更', text: '【ボタン】[簡単解説1分動画]値段変更(ワンバイワン)' },
          { type: 'message', label: 'コメント投稿', text: '【ボタン】[簡単解説1分動画]コメント投稿(ワンバイワン)' },
          { type: 'message', label: 'コメント削除', text: '【ボタン】[簡単解説1分動画]コメント削除(ワンバイワン)' },
        ],
      },
      {
        thumbnailImageUrl: 'https://example.com/bot/images/item2.jpg',
        title: 'ワンバイワン機能②',
        text: 'スペシャルオプション',
        actions: [
          { type: 'message', label: '商品別底値設定', text: '【ボタン】[簡単解説1分動画]商品別底値設定(ワンバイワン)' },
          { type: 'message', label: 'オークション', text: '【ボタン】[簡単解説1分動画]オークション(ワンバイワン)' },
          { type: 'message', label: 'バックアップ', text: '【ボタン】[簡単解説1分動画]バックアップ(ワンバイワン)' },
        ],
      },
      {
        thumbnailImageUrl: 'https://example.com/bot/images/item2.jpg',
        title: 'ワンバイワン機能③',
        text: 'キー押下での商品クリックアクション',
        actions: [
          { type: 'message', label: '再出品', text: '【ボタン】[簡単解説1分動画]再出品(ワンバイワン)' },
          { type: 'message', label: '商品削除', text: '【ボタン】[簡単解説1分動画]商品削除(ワンバイワン)' },
          { type: 'message', label: '配送変更', text: '【ボタン】[簡単解説1分動画]配送変更(ワンバイワン)' },
        ],
      },
      {
        thumbnailImageUrl: 'https://example.com/bot/images/item2.jpg',
        title: 'ビューブースト機能',
        text: 'フリマサイトを便利、楽に使うための表示を追加・挿入します',
        actions: [
          { type: 'message', label: '出品一覧追加情報表示', text: '【ボタン】[簡単解説1分動画]出品一覧追加情報表示(ビューブースト)' },
          { type: 'message', label: 'チェックコントローラー', text: '【ボタン】[簡単解説1分動画]チェックコントローラー(ビューブースト)' },
          { type: 'message', label: 'ショップ調査機能', text: '【ボタン】[簡単解説1分動画]ショップ調査機能(ビューブースト)' },
        ],
      },
      {
        thumbnailImageUrl: 'https://example.com/bot/images/item2.jpg',
        title: 'ワークフロー機能①',
        text: 'ユーザーが毎日手作業で行うルーティンワークを自動化できます',
        actions: [
          { type: 'message', label: '自動化処理予約機能', text: '【ボタン】[簡単解説1分動画]自動化処理予約機能(ワークフロー)' },
          { type: 'message', label: '自動いいね対応機能', text: '【ボタン】[簡単解説1分動画]自動いいね対応機能(ワークフロー)' },
          { type: 'message', label: '自動取引対応機能', text: '【ボタン】[簡単解説1分動画]自動取引対応機能(ワークフロー)' },
        ],
      },
    ],
  },
};

export const ticketOrderTemplate = {
  type: 'template',
  altText: 'コピー出品チケット注文',
  template: {
    type: 'carousel',
    columns: [
      {
        title: '50枚セット',
        text: '750円（税抜き）\n1枚あたり15円',
        actions: [{ type: 'message', label: '50枚を注文', text: '【ボタン】チケット購入 50枚' }],
      },
      {
        title: '100枚セット',
        text: '1,500円（税抜き）\n1枚あたり15円',
        actions: [{ type: 'message', label: '100枚を注文', text: '【ボタン】チケット購入 100枚' }],
      },
      {
        title: '200枚セット',
        text: '3,000円（税抜き）\n1枚あたり15円\n(有料プラン加入者は割引で14円/枚に！)',
        actions: [{ type: 'message', label: '200枚を注文', text: '【ボタン】チケット購入 200枚' }],
      },
      {
        title: '500枚セット',
        text: '7,500円（税抜き）\n1枚あたり15円\n(有料プラン加入者は割引で13円/枚に！)',
        actions: [{ type: 'message', label: '500枚を注文', text: '【ボタン】チケット購入 500枚' }],
      },
      {
        title: '1,000枚セット',
        text: '15,000円（税抜き）\n1枚あたり15円\n(有料プラン加入者は割引で10円/枚に！)',
        actions: [{ type: 'message', label: '1,000枚を注文', text: '【ボタン】チケット購入 1000枚' }],
      },
    ],
  },
};

export function copyTicketFlexMessage() {
  return {
    type: 'flex',
    altText: 'コピー出品チケット30枚無料！',
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/copy_function.png',
        size: 'full',
        aspectRatio: '16:9',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'コピー出品チケット30枚無料でプレゼント！', weight: 'bold', size: 'xl', wrap: true },
          {
            type: 'text',
            text: `🎉【30枚のコピー出品チケットを無料でプレゼント！】🎉\n\nメルカリShops・ラクマ・ヤフオク・Yahoo!フリマへのコピー出品が可能！\n\n商品をコピー出品完了したら1枚消費するチケット制度で、コピー出品だけならサブスクプランへの加入は不要🙅‍♀️\n\n💬下のボタンをタップした後、\nキーコードの入力ボタンを押すだけですぐにご利用いただけます！`,
            size: 'sm',
            color: '#666666',
            margin: 'md',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: { type: 'message', label: 'GETする', text: '【ボタン】コピー出品チケット30枚GET' },
          },
        ],
      },
    },
  };
}

export const surveyTemplate = {
  type: 'flex',
  altText: 'アンケートのお願い',
  contents: {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: 'アンケートのお願い 🙇‍♀️', weight: 'bold', size: 'lg' },
        { type: 'text', text: 'FurimAutoをどこで知りましたか？\n1つ選んで教えてください！', size: 'md', wrap: true, margin: 'md' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', action: { type: 'message', label: 'YouTube', text: '【ボタン】アンケート回答:YouTube' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: 'X', text: '【ボタン】アンケート回答:X' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: 'Instagram', text: '【ボタン】アンケート回答:Instagram' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: 'その他SNS', text: '【ボタン】アンケート回答:その他SNS' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: 'メルカリ物販Lab', text: '【ボタン】アンケート回答:メルカリ物販Lab' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: '知人からの紹介', text: '【ボタン】アンケート回答:紹介' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: 'サブアカウント', text: '【ボタン】アンケート回答:サブアカウント' } },
        { type: 'button', style: 'primary', action: { type: 'message', label: 'その他', text: '【ボタン】アンケート回答:その他' } },
      ],
    },
  },
};

export function surveyButton(altText: string) {
  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: 'https://storage.googleapis.com/furimauto_line/images/messageEvent/follow_event_img3.png',
        size: 'full',
        aspectRatio: '16:9',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '▼ 1問アンケートはこちら ▼', weight: 'bold', size: 'lg', wrap: true, align: 'center' }],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            action: { type: 'message', label: '開始する', text: '【ボタン】アンケート開始' },
          },
        ],
      },
    },
  };
}

// 更新課金でキーコードが再発行されたときの通知（stripe-processorのインライン成功時と
// gas-retry-queueのキュー完遂時で共通）。キーコードはコピーしやすいよう単体メッセージで送る
export function keycodeReissuedMessages(keyCode: string): Array<{ type: 'text'; text: string }> {
  return [
    { type: 'text', text: '🔑 本日の更新でご予約のプラン変更が適用され、キーコードが新しくなりました。\n\n次のメッセージでお送りするキーコードをコピーして、拡張機能のキーコード欄に入力し直してご利用ください。' },
    { type: 'text', text: keyCode },
  ];
}
