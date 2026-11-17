/** Shared by identity admission and the original game's initialization. */
function PartyLoadingScreen({ message, error, onRetry, onEnterName, onReload }) {
  const jsx = partyRouteJsx;

  return jsx.jsxs('main', {
    className: 'bp-party-loading',
    children: [
      jsx.jsxs('h1', {
        className: 'bp-loading-wordmark',
        children: ['better', jsx.jsx('span', { children: '.party' })],
      }),
      jsx.jsx('div', {
        className: 'bp-loading-spinner-slot',
        'aria-hidden': true,
        children: !error && jsx.jsx('div', { className: 'bp-loading-spinner' }),
      }),
      jsx.jsx('p', {
        className: 'bp-loading-message',
        role: error ? 'alert' : 'status',
        children: error || message,
      }),
      jsx.jsxs('div', {
        className: 'bp-loading-actions',
        children: [
          error &&
            onRetry &&
            jsx.jsx('button', {
              className: 'bp-loading-action',
              type: 'button',
              onClick: onRetry,
              children: 'Retry',
            }),
          error &&
            onEnterName &&
            jsx.jsx('button', {
              className: 'bp-loading-action',
              type: 'button',
              onClick: onEnterName,
              children: 'Join again',
            }),
          onReload &&
            jsx.jsx('button', {
              className: 'bp-loading-action',
              type: 'button',
              onClick: onReload,
              children: 'Reload',
            }),
          jsx.jsx('a', {
            href: '/home',
            className: 'bp-loading-action',
            children: 'Back to home',
          }),
        ],
      }),
    ],
  });
}
