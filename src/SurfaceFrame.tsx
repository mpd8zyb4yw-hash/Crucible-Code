import { type ReactNode } from 'react'
import { Fit, useFit, type FitSize } from './fit'

/**
 * The application frame. Exactly one domain application lives in it.
 *
 * The rule this enforces: THE ENTIRE FRAME IS THE WIDGET. Calendar was being
 * rendered as one item in a stack — a big statistic, then view buttons, then
 * navigation, then a heading, then a status line, and finally the calendar
 * itself in whatever height was left. Every one of those rows belongs TO
 * Calendar, so every one of them should have been inside it. Stacking them
 * outside meant the domain application got a minority of its own frame.
 *
 * Two things make that hard to do again:
 *
 *  1. `children` is a single node, and the only thing allowed to render here
 *     is a domain application. `Report` no longer has anywhere to put a stats
 *     block or an action row, because there is no slot for one.
 *  2. The frame publishes its measured size. A renderer that knows it has
 *     343×248 can BUILD a 343×248 application instead of rendering a
 *     desktop-sized one and being clipped.
 *
 * The measuring and the paint boundary are `Fit`'s now rather than this file's.
 * They were written here first and then not applied anywhere else, which is how
 * every level BELOW a surface — a pane, a card's preview, a drawer — ended up
 * bounded by whatever its own author remembered. See fit.tsx.
 */

export type FrameSize = FitSize

/** The frame's real dimensions. Container-driven, never a media query. */
export const useFrame = useFit

export function SurfaceFrame({ children, plane = '' }: { children: ReactNode; plane?: string }) {
  return <Fit name="surface" frame="surface" plane={plane}>{children}</Fit>
}
