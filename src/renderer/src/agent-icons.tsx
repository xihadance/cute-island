interface GeminiIconProps {
  id: string
}

export function ClaudeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <rect
          key={index}
          x="10.7"
          y="2.1"
          width="2.6"
          height="6.4"
          rx="1.3"
          fill="currentColor"
          transform={`rotate(${index * 45} 12 12)`}
        />
      ))}
    </svg>
  )
}

export function CodexIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12 2.1 20.5 7 20.5 17 12 21.9 3.5 17 3.5 7ZM12 8 16.3 10.5 16.3 15.3 12 17.8 7.7 15.3 7.7 10.5Z"
      />
    </svg>
  )
}

export function GeminiIcon({ id }: GeminiIconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4c8dff" />
          <stop offset="0.55" stopColor="#9b6bff" />
          <stop offset="1" stopColor="#ff6ec7" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M12 1.1 14.05 8.2 21.9 12 14.05 15.8 12 22.9 9.95 15.8 2.1 12 9.95 8.2Z"
      />
    </svg>
  )
}

export function CursorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#ffffff" d="M12 2.2 21 7.3 12 12.4 3 7.3Z" />
      <path fill="#c8c8c8" d="M3 7.3 12 12.4 12 21.8 3 16.7Z" />
      <path fill="#8f8f8f" d="M21 7.3 12 12.4 12 21.8 21 16.7Z" />
    </svg>
  )
}
