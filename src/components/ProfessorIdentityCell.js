import React from 'react';

export function ProfessorIdentityCell({ identityState, field, letterId, onRetry }) {
  if (identityState?.status === 'loading' || !identityState) {
    return React.createElement(
      'span',
      { className: 'student-detail-message', role: 'status' },
      'Loading…',
    );
  }
  if (identityState.status === 'error') {
    return React.createElement(
      'span',
      { className: 'professor-identity-error' },
      React.createElement('span', { role: 'alert' }, 'Could not load'),
      React.createElement(
        'button',
        {
          className: 'review-link',
          type: 'button',
          'aria-label': 'Retry student identity lookup',
          onClick: () => onRetry(letterId),
        },
        'Retry',
      ),
    );
  }

  const value = identityState.identity?.[field];
  return value
    ? value
    : React.createElement('span', { className: 'muted-dash' }, 'Unavailable');
}
