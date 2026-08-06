import { useRef } from 'react'
import { css, cssv } from './css'
import { accentOf, skinOf } from './heat'
import type { Need } from './api'

interface Props {
  dateLabel: string
  place: string | null
  readLine: string
  needs: Need[]
  quietLog: string[]
  showQuiet: boolean
  needsBrain: boolean
  needsSignIn: boolean
  thinking: boolean
  doneIds: Set<string>
  onToggleQuiet: () => void
  onOpen: (id: string) => void
  onOpenSettings: () => void
  onAct: (need: Need) => void
}

export default function Home({
  dateLabel, place, readLine, needs, quietLog, showQuiet, needsBrain, needsSignIn, thinking, doneIds,
  onToggleQuiet, onOpen, onOpenSettings, onAct,
}: Props) {
  // Long-press the send button is the quiet way back into settings.
  const timer = useRef<number | null>(null)
  const held = useRef(false)
  const startHold = () => {
    held.current = false
    timer.current = window.setTimeout(() => { held.current = true; onOpenSettings() }, 500)
  }
  const endHold = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  const hero = needs.find((n) => n.tier === 'hero')
  const ember = needs.find((n) => n.tier === 'ember')
  const quiet = needs.filter((n) => n.tier === 'quiet')

  return (
    <>
      <div style={css('flex:1; overflow-y:auto; padding:8px 18px 14px; display:flex; flex-direction:column; gap:18px;')}>

        {/* No greeting, in any language. The top is date, time and — only if he
            wants it — place, each written in his own conventions, not a
            locale's. The line under it is the only thing with anything to say. */}
        <div style={css('flex:none; padding:6px 2px 0;')}>
          <div style={css('display:flex; align-items:center; gap:9px;')}>
            <div style={css('width:7px; height:7px; border-radius:999px; background:#F0A56B; box-shadow:0 0 9px rgba(240,165,107,.6); animation:cruPulse 3.6s ease-in-out infinite;')} />
            <div style={css('font-size:13px; color:rgba(237,238,241,.4);')}>{dateLabel}</div>
            {place && (
              <div style={css('font-size:13px; color:rgba(237,238,241,.28); margin-left:auto;')}>{place}</div>
            )}
          </div>
          <div style={css('margin-top:10px; font-size:19px; font-weight:500; line-height:1.35; letter-spacing:-.022em; color:rgba(237,238,241,.92); text-wrap:pretty;')}>
            {thinking ? 'Thinking…' : readLine}
          </div>
        </div>

        {needsSignIn && (
          <a href="/auth/login" style={css('flex:none; position:relative; border-radius:26px; padding:17px 19px; cursor:pointer; overflow:hidden; display:block; color:inherit; background:linear-gradient(160deg, rgba(48,38,26,.5), rgba(26,22,18,.4)); box-shadow:inset 0 1.5px 0 rgba(255,220,170,.16), inset 0 0 0 1px rgba(240,165,107,.2);')}>
            <div style={css('display:flex; align-items:center; gap:7px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:#F0A56B;')}>
              <div style={css('width:6px; height:6px; border-radius:999px; background:#F0A56B; box-shadow:0 0 7px #F0A56B;')} />
              needs you · to begin
            </div>
            <div style={css('margin-top:11px; font-size:21px; font-weight:600; letter-spacing:-.028em; line-height:1.2;')}>Sign in and I’ll pick things up.</div>
            <div style={css('margin-top:11px; font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.62);')}>One Google sign-in — it’s how I know it’s you, and how I see your calendar, mail and activity.</div>
            <div style={css('margin-top:15px; padding:10px 15px; border-radius:12px; background:rgba(237,238,241,.92); color:#0B0B0D; font-size:13px; font-weight:600; display:inline-block;')}>Sign in with Google</div>
          </a>
        )}

        {needsBrain && !needsSignIn && (
          <div onClick={onOpenSettings} style={css('flex:none; position:relative; border-radius:26px; padding:17px 19px; cursor:pointer; overflow:hidden; background:linear-gradient(160deg, rgba(48,38,26,.5), rgba(26,22,18,.4)); box-shadow:inset 0 1.5px 0 rgba(255,220,170,.16), inset 0 0 0 1px rgba(240,165,107,.2);')}>
            <div style={css('position:relative;')}>
              <div style={css('display:flex; align-items:center; gap:7px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:#F0A56B;')}>
                <div style={css('width:6px; height:6px; border-radius:999px; background:#F0A56B; box-shadow:0 0 7px #F0A56B;')} />
                needs you · to begin
              </div>
              <div style={css('margin-top:11px; font-size:21px; font-weight:600; letter-spacing:-.028em; line-height:1.2;')}>I need a model to think with.</div>
              <div style={css('margin-top:11px; font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.62);')}>Connect a key from any provider — a free tier is enough to start.</div>
              <div style={css('margin-top:15px; display:flex; gap:9px; align-items:center;')}>
                <div style={css('padding:10px 15px; border-radius:12px; background:rgba(237,238,241,.92); color:#0B0B0D; font-size:13px; font-weight:600;')}>Connect a model</div>
                <div style={css('font-size:12.5px; color:rgba(237,238,241,.5);')}>or long-press ↑ any time</div>
              </div>
            </div>
          </div>
        )}

        {/* hero — the one thing that most wants attention */}
        {hero && <HeroCard need={hero} done={doneIds.has(hero.id)} onOpen={onOpen} onAct={onAct} />}

        {/* ember — a warm second */}
        {ember && <EmberCard need={ember} done={doneIds.has(ember.id)} onOpen={onOpen} />}

        {quiet.length > 0 && (
          <div style={css('flex:none; display:flex; flex-direction:column;')}>
            <div style={css('font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:rgba(237,238,241,.3); padding:0 2px 4px;')}>quiet, for when you want it</div>
            {quiet.map((n, i) => (
              <div
                key={n.id}
                onClick={() => onOpen(n.id)}
                style={cssv`padding:15px 4px; cursor:pointer; display:flex; align-items:center; gap:14px;${i < quiet.length - 1 ? ' box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);' : ''}`}
              >
                {(() => {
                  const color = doneIds.has(n.id) ? '#5FC9A6' : accentOf(n.accent, n.heat)
                  return n.glyph ? (
                    <Glyph glyph={n.glyph} color={color} />
                  ) : (
                    <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center;')}>
                      <div style={cssv`width:7px; height:7px; border-radius:999px; background:${color};`} />
                    </div>
                  )
                })()}
                <div style={css('flex:1;')}>
                  <div style={css('font-size:15px; font-weight:500;')}>{n.title}</div>
                  <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>{n.sub}</div>
                </div>
                <div style={css('font-size:16px; color:rgba(237,238,241,.28);')}>›</div>
              </div>
            ))}
          </div>
        )}

        {quietLog.length > 0 && (
          <div onClick={onToggleQuiet} style={css('flex:none; padding:2px 4px 8px; cursor:pointer;')}>
            <div style={css('font-size:12.5px; color:rgba(237,238,241,.3);')}>
              {showQuiet ? 'hide' : `${quietLog.length} thing${quietLog.length === 1 ? '' : 's'} handled without you today`}
            </div>
            {showQuiet && (
              <div style={css('margin-top:11px; display:flex; flex-direction:column; gap:9px;')}>
                {quietLog.map((q, i) => (
                  <div key={i} style={css('display:flex; gap:10px; font-size:13px; color:rgba(237,238,241,.46);')}>
                    <div style={css('width:5px; height:5px; margin-top:7px; flex:none; border-radius:999px; background:rgba(237,238,241,.26);')} />
                    <div style={css('flex:1; line-height:1.45;')}>{q}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div
        onClick={() => { if (!held.current) onOpen('ask') }}
        style={css('flex:none; margin:0 16px 20px; padding:13px 16px; border-radius:22px; background:rgba(30,32,37,.4); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.08); display:flex; align-items:center; gap:11px; cursor:pointer;')}
      >
        <div style={css('font-size:14px; color:rgba(237,238,241,.42); flex:1;')}>Ask Crucible anything…</div>
        <div
          onPointerDown={startHold}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onContextMenu={(e) => e.preventDefault()}
          style={css('width:30px; height:30px; border-radius:999px; background:rgba(237,238,241,.9); display:flex; align-items:center; justify-content:center; color:#0B0B0D; font-size:15px; touch-action:none; -webkit-user-select:none; user-select:none;')}
        >↑</div>
      </div>
    </>
  )
}

function HeroCard({ need, done, onOpen, onAct }: { need: Need; done: boolean; onOpen: (id: string) => void; onAct: (n: Need) => void }) {
  const s = skinOf(done ? 'handled' : need.heat)
  return (
    <div onClick={() => onOpen(need.id)} style={cssv`flex:none; position:relative; border-radius:26px; padding:17px 19px; cursor:pointer; overflow:hidden; background:${s.bg}; box-shadow:${s.shadow};`}>
      {s.glow && <div style={cssv`position:absolute; right:-18%; top:-40%; width:60%; height:130%; border-radius:999px; background:${s.glow}; filter:blur(28px); pointer-events:none;`} />}
      <div style={css('position:relative;')}>
        <div style={css('display:flex; align-items:center; justify-content:space-between;')}>
          <div style={cssv`display:flex; align-items:center; gap:7px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:${s.labelColor};`}>
            <div style={cssv`width:6px; height:6px; border-radius:999px; background:${s.dot};${s.dotGlow ? ` box-shadow:0 0 7px ${s.dot};` : ''}`} />
            {done ? 'handled' : need.heatLabel}
          </div>
          <div style={css('font-size:11.5px; color:rgba(237,238,241,.4);')}>open ›</div>
        </div>
        <div style={css('margin-top:11px; font-size:21px; font-weight:600; letter-spacing:-.028em; line-height:1.2;')}>{need.title}</div>
        {need.gauges ? (
          <div style={css('margin-top:13px; display:flex; align-items:center; gap:14px;')}>
            <div style={css('display:flex; gap:7px;')}>
              {need.gauges.map((g, i) => (
                <div key={i} style={css('width:22px; height:32px; border-radius:5px 5px 7px 7px; background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.12); display:flex; flex-direction:column; justify-content:flex-end; overflow:hidden;')}>
                  {/* A handled card cools its gauges too, the way the design does. */}
                  <div style={cssv`height:${Math.round(g.fill * 100)}%; background:${done ? 'rgba(95,201,166,.6)' : accentOf(g.accent, need.heat)};`} />
                </div>
              ))}
            </div>
            <div style={css('flex:1; font-size:12.5px; line-height:1.4; color:rgba(237,238,241,.62);')}>{need.sub}</div>
          </div>
        ) : (
          <div style={css('margin-top:13px; font-size:12.5px; line-height:1.4; color:rgba(237,238,241,.62);')}>{need.sub}</div>
        )}
        {need.action && (
          <div style={css('margin-top:15px; display:flex; gap:9px; align-items:center;')}>
            <div
              onClick={(e) => { e.stopPropagation(); if (!done) onAct(need) }}
              style={cssv`padding:10px 15px; border-radius:12px; background:${done ? 'rgba(95,201,166,.18)' : 'rgba(237,238,241,.92)'}; color:${done ? '#8FE0AE' : '#0B0B0D'}; font-size:13px; font-weight:600;`}
            >
              {done ? need.action.done : need.action.label}
            </div>
            <div style={css('font-size:12.5px; color:rgba(237,238,241,.5);')}>
              {done ? 'I’ll keep you posted' : 'or open it to talk it through'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function EmberCard({ need, done, onOpen }: { need: Need; done: boolean; onOpen: (id: string) => void }) {
  const s = skinOf(done ? 'handled' : need.heat)
  return (
    <div onClick={() => onOpen(need.id)} style={cssv`flex:none; position:relative; border-radius:24px; padding:16px 18px; cursor:pointer; overflow:hidden; background:${s.bg}; box-shadow:${s.shadow};`}>
      <div style={css('display:flex; align-items:center; justify-content:space-between;')}>
        <div style={cssv`display:flex; align-items:center; gap:7px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:${s.labelColor};`}>
          <div style={cssv`width:6px; height:6px; border-radius:999px; background:${s.dot};`} />
          {need.heatLabel}
        </div>
        <div style={css('font-size:11.5px; color:rgba(237,238,241,.38);')}>open ›</div>
      </div>
      <div style={css('margin-top:11px; font-size:18px; font-weight:600; letter-spacing:-.02em;')}>{need.title}</div>
      {need.meter ? (
        <>
          <div style={css('margin-top:12px; height:7px; border-radius:999px; background:rgba(255,255,255,.07); overflow:hidden;')}>
            <div style={cssv`width:${Math.round(need.meter.fill * 100)}%; height:100%; border-radius:999px; background:linear-gradient(90deg,${s.dot},${s.dot}4D);`} />
          </div>
          <div style={css('margin-top:7px; display:flex; justify-content:space-between; font-size:11.5px; color:rgba(237,238,241,.44);')}>
            <div>{need.meter.left}</div>
            <div>{need.meter.right}</div>
          </div>
        </>
      ) : (
        <div style={css('margin-top:7px; font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.44);')}>{need.sub}</div>
      )}
    </div>
  )
}

/** The 40px tile beside a quiet row. Three shapes, straight from the design. */
function Glyph({ glyph, color }: { glyph: NonNullable<Need['glyph']>; color: string }) {
  if (glyph.kind === 'dots') {
    const [done = 0, total = 8] = glyph.values
    const n = Math.max(1, Math.min(8, Math.round(total)))
    return (
      <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:grid; grid-template-columns:repeat(4,1fr); gap:4px; padding:10px 8px; align-content:center;')}>
        {Array.from({ length: n }, (_, i) => (
          <div
            key={i}
            style={i < Math.round(done)
              ? cssv`width:4px; height:4px; border-radius:999px; background:${color};`
              : css('width:4px; height:4px; border-radius:999px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.2);')}
          />
        ))}
      </div>
    )
  }
  if (glyph.kind === 'lines') {
    return (
      <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; flex-direction:column; justify-content:center; gap:4px; padding:0 9px;')}>
        {glyph.values.map((w, i) => (
          <div
            key={i}
            style={cssv`height:3px; border-radius:2px; width:${Math.round(Math.max(0, Math.min(1, w)) * 100)}%; background:${i === 0 ? color : 'rgba(237,238,241,.26)'};`}
          />
        ))}
      </div>
    )
  }
  return (
    <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:flex-end; justify-content:center; gap:3px; padding:0 8px 10px;')}>
      {glyph.values.map((v, i) => {
        const t = Math.max(0, Math.min(1, v))
        return <div key={i} style={cssv`flex:1; border-radius:2px; height:${Math.round(t * 20)}px; background:${t < .4 ? color : 'rgba(237,238,241,.24)'};`} />
      })}
    </div>
  )
}
