import { useCrucibleStore } from './state/store'
import BackgroundBlobs from './components/shared/BackgroundBlobs'
import NavRail from './components/NavRail'
import ChatView from './components/chat/ChatView'
import AgentsView from './components/agents/AgentsView'
import HistoryView from './components/history/HistoryView'
import SettingsView from './components/settings/SettingsView'

export default function App() {
  const tab = useCrucibleStore((s) => s.tab)

  return (
    <div
      style={{
        height: '100vh',
        width: '100%',
        background: '#101016',
        display: 'flex',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: '#e4e4ee',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <BackgroundBlobs />
      <NavRail />
      {tab === 'chat' && <ChatView />}
      {tab === 'agents' && <AgentsView />}
      {tab === 'history' && <HistoryView />}
      {tab === 'settings' && <SettingsView />}
    </div>
  )
}
