export function updateProfessorIdentityState(current, {
  letterId,
  accountId,
  requestId,
  status,
  identity,
}) {
  if (!accountId) return current;

  const sameAccount = current.accountId === accountId;
  const uninitialized = current.accountId === null && Object.keys(current.byLetterId).length === 0;
  const currentRequestId = sameAccount ? current.byLetterId[letterId]?.requestId : null;
  if (!sameAccount && !uninitialized) return current;
  if (currentRequestId != null && requestId < currentRequestId) return current;

  return {
    accountId,
    byLetterId: {
      ...(sameAccount ? current.byLetterId : {}),
      [letterId]: { status, identity, requestId },
    },
  };
}

export function getProfessorIdentityStatesForAccount(state, accountId) {
  return state.accountId === accountId ? state.byLetterId : {};
}
