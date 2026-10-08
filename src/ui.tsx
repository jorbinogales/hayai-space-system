import { Blobvatar } from './blob'
import { useState } from 'react'
import { Chat } from './Chat'
import { Notifications } from './Notifications'
import { Search } from './SearchPalette'
import { ClockBlock } from './TopInfo'
import { openChangelog } from './updates'

const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9ZM10.3 21a1.94 1.94 0 0 0 3.4 0',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z',
  arrow: 'M5 12h14M12 5l7 7-7 7',
  back: 'm15 18-6-6 6-6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  wallet: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4',
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  check: 'm9 11 3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  chart: 'M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z',
  phone: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3ZM11 18h2',
  cart: 'M3 4h2.5l2 11h10l2-8H7M9.5 19.5h.01M16.5 19.5h.01',
  palette: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-1.4-1.2-1.7-1.2-2.8 0-.9.7-1.4 1.6-1.4H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3ZM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  plus: 'M5 12h14M12 5v14',
  close: 'M6 6l12 12M18 6L6 18',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  minus: 'M5 12h14',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  print: 'M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7v-7Z',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
  archive: 'M3 4h18v4H3ZM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  key: 'M15.5 7.5 19 4M17 6l3 3M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8ZM11.4 11.6 17 6',
  radar: 'M12 3a9 9 0 1 0 9 9M12 12l5.5-5.5M12 7.5a4.5 4.5 0 1 0 4.5 4.5M12 12h.01',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM16 2v4M8 2v4M3 10h18',
}
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

export function Topbar({ user, onLogout, onProfile, onIntegrations, onVault }: { user?: { name: string; avatar: string }; onLogout?: () => void; onProfile?: () => void; onIntegrations?: () => void; onVault?: () => void }) {
  const [menu, setMenu] = useState(false)
  return (
    <header className="topbar">
      <div className="mark">
        <p className="mark-word">HAYAI</p>
        <p className="mark-tag">TODO ESTÁ CONECTADO</p>
      </div>
      <div className="tools">
        {user && (
          <>
            <Search />
            <Chat />
            <Notifications />
          </>
        )}
        {user && (
          <div className="acct">
            <button className="avatar" aria-label={`Cuenta de ${user.name}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Blobvatar seed={user.avatar} size={38} />
            </button>
            {menu && (
              <div className="acct-menu" role="menu">
                <p>
                  <small>Astronauta</small>
                  {user.name}
                </p>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onProfile?.()
                  }}
                >
                  Mi perfil
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onIntegrations?.()
                  }}
                >
                  Integraciones
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onVault?.()
                  }}
                >
                  Papelera y archivo
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    openChangelog()
                  }}
                >
                  Historial de versiones
                </button>
                <button role="menuitem" onClick={onLogout}>
                  Cerrar sesión
                </button>
              </div>
            )}
          </div>
        )}
        <ClockBlock />
      </div>
    </header>
  )
}

export function ZoomControls({ onZoom }: { onZoom: (factor: number) => void }) {
  return (
    <>
      <div className="zoom">
        <button className="round" aria-label="Acercar" onClick={() => onZoom(1.15)}>
          <Icon name="plus" />
        </button>
        <button className="round" aria-label="Alejar" onClick={() => onZoom(1 / 1.15)}>
          <Icon name="minus" />
        </button>
      </div>
      <span className="mini-orbit" aria-hidden="true" />
    </>
  )
}
