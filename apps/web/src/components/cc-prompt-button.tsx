'use client'

import { type PromptTemplate } from '@/components/prompt-modal'

interface CcPromptButtonProps {
  prompts: PromptTemplate[]
}

// FurimAuto: 右下常駐の「CCに依頼」FAB とプロンプトモーダルは使わないため無効化。
// 各ページの <CcPromptButton prompts={...} /> 呼び出しは upstream との差分を
// 増やさないようそのまま残し、ここで一括 null を返す。
export default function CcPromptButton(_props: CcPromptButtonProps) {
  return null
}
