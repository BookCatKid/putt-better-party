/** Preserve the original rejoin layout while the game initializes. */
function PartyLoadingScreen({ code, message, error, onRetry, onEnterName, onReload }) {
  const jsx = partyRouteJsx;

  return jsx.jsx('main', {
    className: 'bp-home bp-party-loading',
    // Marks this as a blocking overlay: while it is up the game scene behind it
    // must not take input or focus. See scripts/party-overlay.js.
    'data-bp-blocking-overlay': '',
    children: jsx.jsxs('section', {
      className: 'bp-entry',
      children: [
        jsx.jsxs('h1', {
          className: 'bp-wordmark',
          children: ['better', jsx.jsx('span', { children: '.party' })],
        }),
        jsx.jsxs('p', {
          className: 'bp-join-code',
          children: ['Party ', jsx.jsx('strong', { children: code })],
        }),
        jsx.jsxs('p', {
          className: 'bp-resume-status',
          children: [
            !error &&
              jsx.jsx('span', {
                className: 'bp-loading-spinner',
                'aria-hidden': true,
              }),
            jsx.jsx('span', {
              className: 'bp-loading-message',
              role: error ? 'alert' : 'status',
              children: jsx.jsx('span', { children: error || message }),
            }),
          ],
        }),
        error &&
          onRetry &&
          jsx.jsx('button', {
            className: 'bp-create bp-loading-action',
            type: 'button',
            onClick: onRetry,
            children: 'Retry',
          }),
        error &&
          onEnterName &&
          jsx.jsx('button', {
            className: 'bp-create bp-loading-action',
            type: 'button',
            onClick: onEnterName,
            children: 'Join again',
          }),
        onReload &&
          jsx.jsx('button', {
            className: 'bp-create bp-loading-action',
            type: 'button',
            onClick: onReload,
            children: 'Reload',
          }),
        jsx.jsx('a', {
          href: '/home',
          className: 'bp-resume bp-back bp-loading-action',
          children: 'Back to home',
        }),
      ],
    }),
  });
}
