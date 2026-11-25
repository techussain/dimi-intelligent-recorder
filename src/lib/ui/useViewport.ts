import { useEffect, useState } from 'react'

export interface Viewport {
  width: number
  height: number
  /** < 768px */
  isMobile: boolean
  /** 768–1023px */
  isTablet: boolean
  /** ≥ 1024px */
  isDesktop: boolean
}

function read(): Viewport {
  const w = window.innerWidth
  const h = window.innerHeight
  return {
    width: w,
    height: h,
    isMobile: w < 768,
    isTablet: w >= 768 && w < 1024,
    isDesktop: w >= 1024,
  }
}

export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(() =>
    typeof window === 'undefined'
      ? {
          width: 1440,
          height: 900,
          isMobile: false,
          isTablet: false,
          isDesktop: true,
        }
      : read(),
  )
  useEffect(() => {
    const onResize = () => {
      // Chromium on Windows fires resize with near-zero dimensions when the
      // window is minimized. Ignore resize events while the page is not
      // visible to avoid spurious isMobile=true flashes that unmount the editor.
      if (document.visibilityState === 'hidden') return
      setVp(read())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return vp
}
