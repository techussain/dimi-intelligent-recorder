import { Monitor, Smartphone } from 'lucide-react'
import { BrandMark } from './BrandMark'

export function MobileGate() {
  return (
    <div className="h-full w-full flex items-center justify-center p-6">
      <div className="panel max-w-sm w-full p-6 text-center">
        <div className="flex justify-center mb-4">
          <BrandMark size={48} />
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-1">
          Open on a larger screen
        </h1>
        <p className="text-sm text-muted leading-relaxed mb-5">
          Dimi Intelligent Recorder is a full timeline editor that captures your screen,
          mic and webcam while you edit. It needs a desktop or tablet with ≥ 768&nbsp;px
          width.
        </p>
        <div className="flex items-center justify-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <Smartphone size={14} /> Not supported
          </span>
          <span className="opacity-30">→</span>
          <span className="flex items-center gap-1.5 text-fg">
            <Monitor size={14} /> Desktop
          </span>
        </div>
      </div>
    </div>
  )
}
