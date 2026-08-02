// FurimAuto独自: タグ名 → 付与/削除タイミングの説明。
// 一次資料: docs/furimauto/tags.md。タグ付与ロジックを変えたら両方更新する。

export interface TagTiming {
  assign: string
  remove?: string
  category?: string
}

const EXACT: Record<string, TagTiming> = {
  無料試用期間中: {
    category: '状態',
    assign: '友だち追加（新規ユーザー）時に付与',
    remove: '試用期間終了（残日数0）または月額解約時に削除',
  },
  紹介経由: {
    category: '流入元',
    assign: '友達紹介コードの処理が完了した時に付与',
    remove: '削除されない（永続）',
  },
  Furimanです: {
    category: 'アクション',
    assign: '「Furimanです」キーワード送信 → Youtubeクーポン付与成功時',
    remove: '削除されない',
  },
  解説見た: {
    category: 'アクション',
    assign: '完全解説動画のキーワード送信 → 試用延長成功時',
    remove: '削除されない',
  },
  月額会員: {
    category: '課金状態',
    assign: 'Stripe 月額サブスク登録・継続課金成功時に付与',
    remove: 'Stripe サブスク解約時に削除',
  },
  サブアカウント: {
    category: 'アカウント種別',
    assign: 'サブアカウント識別用（手動/運用付与）',
    remove: '削除されない',
  },
  サブ垢: {
    category: 'アカウント種別',
    assign: 'サブアカウント識別用（手動/運用付与）',
    remove: '削除されない',
  },
  キャンセル済み: {
    category: '課金状態',
    assign: 'Stripe サブスク解約時に付与',
    remove: '再購読時に削除',
  },
  ブロック: {
    category: '状態',
    assign: 'ユーザーがブロック（unfollow）した時に付与',
    remove: '再フォロー時（運用）',
  },
  未使用ユーザー: {
    category: '試用終了後分類',
    assign: '試用期間終了時、セグメント1〜3のみだったユーザーに付与',
    remove: '削除されない',
  },
  見込客: {
    category: '試用終了後分類',
    assign: '試用期間終了時、セグメント4〜8を持っていたユーザーに付与',
    remove: '削除されない',
  },
}

const SEGMENT_DEFS: Record<string, string> = {
  '1': 'アンケート未回答（フォロー時の初期状態）',
  '2': 'アンケート回答完了時',
  '3': 'キーコード発行成功時',
  '4': '拡張機能インストールを GAS が検知 → scenario-switch',
  '5': 'メルカリURL登録（自動化を1度でも実行）を GAS が検知',
  '6': 'FREEコピー出品チケット取得時',
  '7': 'Youtubeクーポン取得（Furimanですキーワード）時',
  '8': '完全解説動画のキーワード送信時',
}

export function getTagTiming(name: string): TagTiming {
  if (EXACT[name]) return EXACT[name]

  const seg = name.match(/^セグメント([1-8])$/)
  if (seg) {
    return {
      category: 'ファネル位置',
      assign: `${SEGMENT_DEFS[seg[1]]}に切り替え付与`,
      remove: '上位セグメントへ移行時・試用終了時に削除（常に1つだけ保持）',
    }
  }

  const plan = name.match(/^月額(3000|5000|8000|10000|15000|19800)$/)
  if (plan) {
    return {
      category: '課金プラン',
      assign: `Stripe 課金額が ${plan[1]}円ティアの時に付与（amount <= ${plan[1]}）`,
      remove: 'Stripe サブスク解約時に削除',
    }
  }

  const amb = name.match(/^アンバサダーLv\.(1|5|10)$/)
  if (amb) {
    return {
      category: 'アンバサダー',
      assign: `紹介完了後 getAmbassadorInfo の応答が Lv.${amb[1]} 相当の時に付与`,
      remove: 'Lvアップ時に旧Lvタグを削除して新Lvを付与',
    }
  }

  return {
    assign: '付与タイミング未定義（手動付与、または新規タグ）',
  }
}
