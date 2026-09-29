const participantId = (process.env.PARTICIPANT_ID ?? '').trim().toLowerCase();
const hostId = (process.env.HOST_ID ?? '').trim().toLowerCase();
const accountId = (process.env.ACCOUNT_ID ?? '').trim().toLowerCase();

const HOST_ALLOWLIST = {
  p1: ['host-p1', 'participant-1', 'p1-host'],
  p2: ['host-p2', 'participant-2', 'p2-host'],
  p3: ['host-p3', 'participant-3', 'p3-host'],
  coordinator: ['coordinator-host', 'coordinator-node'],
};

const ACCOUNT_ALLOWLIST = {
  p1: ['account-p1', 'participant-1'],
  p2: ['account-p2', 'participant-2'],
  p3: ['account-p3', 'participant-3'],
  coordinator: ['coordinator-account'],
};

if (!participantId) {
  console.error('PARTICIPANT_ID is required.');
  process.exit(1);
}

const expectedHosts = HOST_ALLOWLIST[participantId] ?? [];
const expectedAccounts = ACCOUNT_ALLOWLIST[participantId] ?? [];

if (hostId && expectedHosts.length > 0 && !expectedHosts.includes(hostId)) {
  console.error(`Participant ${participantId} is bound to host ${hostId}, which is not in the allowlist: ${expectedHosts.join(', ')}`);
  process.exit(1);
}

if (accountId && expectedAccounts.length > 0 && !expectedAccounts.includes(accountId)) {
  console.error(`Participant ${participantId} is bound to account ${accountId}, which is not in the allowlist: ${expectedAccounts.join(', ')}`);
  process.exit(1);
}

console.log(`Participant policy OK: ${participantId} on host=${hostId || 'unset'} account=${accountId || 'unset'}`);
