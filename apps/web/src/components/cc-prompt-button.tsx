'use client'

import { type PromptTemplate } from '@/components/prompt-modal'

interface CcPromptButtonProps {
  prompts: PromptTemplate[]
  /**
   * 固定位置を指定する Tailwind クラス。既定は右下。
   * チャット画面のようにページ下端まで操作要素がある画面では、送信ボタンと
   * 重なってクリックを奪ってしまうため、呼び出し側でずらす。
   */
  positionClassName?: string
}

// FurimAuto: 右下常駐の「CCに依頼」FAB とプロンプトモーダルは使わないため無効化。
// 各ページの <CcPromptButton prompts={...} /> 呼び出しは upstream との差分を
// 増やさないようそのまま残し、ここで一括 null を返す。
export default function CcPromptButton(_props: CcPromptButtonProps) {
  return null
}
