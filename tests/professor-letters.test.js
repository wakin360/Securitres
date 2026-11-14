import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { ProfessorIdentityCell } from '../src/components/ProfessorIdentityCell.js';

const professorServiceSource = await readFile(new URL('../src/services/professorLetters.js', import.meta.url), 'utf8');
const supabaseModuleUrl = `data:text/javascript,${encodeURIComponent("export function getSupabaseClient() { throw new Error('Use a test client.'); }")}`;
const secureApiModuleUrl = `data:text/javascript,${encodeURIComponent("export function getSecureData() { throw new Error('Inject a test secure-data request.'); }")}`;
const testableProfessorModule = professorServiceSource.replace(
  "'../lib/supabase.js'",
  JSON.stringify(supabaseModuleUrl),
).replace("'./secureApi.js'", JSON.stringify(secureApiModuleUrl));
const { createProfessorLetterService } = await import(`data:text/javascript,${encodeURIComponent(testableProfessorModule)}`);
const {
  getProfessorIdentityStatesForAccount,
  updateProfessorIdentityState,
} = await import('../src/utils/professorIdentityState.js');

const professorId = 'professor-1';
const otherProfessorId = 'professor-2';
const courseA = { id: 'course-a', professor_id: professorId, course_code: 'CS101', course_name: 'Programming', section: 'A' };
const courseB = { id: 'course-b', professor_id: otherProfessorId, course_code: 'MATH2', course_name: 'Mathematics', section: 'B' };
const approvedLetter = {
  id: 'letter-approved',
  course_id: courseA.id,
  absence_start: '2026-10-10',
  absence_end: '2026-10-11',
  reason: 'Medical appointment',
  status: 'approved',
  submitted_at: '2026-10-12T10:00:00Z',
  decided_at: '2026-10-13T10:00:00Z',
  course: { id: courseA.id, course_code: courseA.course_code, course_name: courseA.course_name, section: courseA.section },
};

function makeClient({
  role = 'professor',
  userId = professorId,
  data = {},
  errors = {},
  secureResults = {},
  secureErrors = {},
} = {}) {
  const queries = [];
  const signedUrlRequests = [];
  const secureCalls = [];
  const client = {
    auth: {
      getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }),
    },
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path, expiresIn) => {
          signedUrlRequests.push({ bucket, path, expiresIn });
          return { data: { signedUrl: `https://private.example/${path}?expires=${expiresIn}` }, error: null };
        },
      }),
    },
    from(table) {
      const request = { table, selection: '', filters: [], range: null };
      queries.push(request);
      const builder = {
        select(selection) { request.selection = selection; return builder; },
        eq(column, value) { request.filters.push((row) => row[column] === value); return builder; },
        in(column, values) { request.filters.push((row) => values.includes(row[column])); return builder; },
        order() { return builder; },
        range(from, to) { request.range = [from, to]; return builder; },
        maybeSingle() { return execute().then(({ data: rows, error }) => ({ data: rows?.[0] ?? null, error })); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      async function execute() {
        if (errors[table]) return { data: null, error: errors[table] };
        let rows = data[table] || [];
        if (table === 'profiles') rows = [{ id: userId, role }];
        rows = rows.filter((row) => request.filters.every((filter) => filter(row)));
        if (request.range) rows = rows.slice(request.range[0], request.range[1] + 1);
        return { data: rows, error: null };
      }
      return builder;
    },
  };
  const requestSecureData = async (action, params) => {
    secureCalls.push({ action, params });
    if (secureErrors[action]) throw secureErrors[action];
    return secureResults[action] ?? null;
  };
  return {
    client,
    queries,
    secureCalls,
    secureErrors,
    signedUrlRequests,
    service: createProfessorLetterService(() => client, requestSecureData),
  };
}

test('Professor service loads only the authenticated Professor course assignments', async () => {
  const { service, queries } = makeClient({
    data: { course_offerings: [courseA, courseB] },
  });

  assert.deepEqual(await service.getProfessorCourses(), [courseA]);
  assert.ok(queries.some((query) => query.table === 'course_offerings' && query.selection.includes('course_code')));
});

test('Professor service requests approved letters through the authorized server endpoint', async () => {
  const { service, queries, secureCalls } = makeClient({
    secureResults: { 'professor-letters': [approvedLetter] },
  });

  assert.deepEqual(await service.getProfessorLetters(), [approvedLetter]);
  assert.deepEqual(secureCalls, [{ action: 'professor-letters', params: undefined }]);
  assert.equal(queries.some((query) => query.table === 'excuse_letters'), false);
});

test('Professor letter endpoint returns an empty list when no letters are assigned', async () => {
  const { service, queries, secureCalls } = makeClient({
    secureResults: { 'professor-letters': [] },
  });

  assert.deepEqual(await service.getProfessorLetters(), []);
  assert.equal(queries.some((query) => query.table === 'excuse_letters'), false);
  assert.equal(secureCalls[0].action, 'professor-letters');
});

test('Professor detail uses the scoped server endpoint and exposes no decision operations', async () => {
  const { service, queries, secureCalls } = makeClient({
    secureResults: { 'professor-letters': approvedLetter },
  });

  assert.deepEqual(await service.getProfessorLetterDetails(approvedLetter.id), approvedLetter);
  assert.deepEqual(secureCalls, [{ action: 'professor-letters', params: { letterId: approvedLetter.id } }]);
  assert.equal(queries.some((query) => query.table === 'excuse_letters'), false);
  assert.equal(typeof service.getProfessorLetterStudentIdentity, 'function');
  assert.equal(service.approveLetter, undefined);
  assert.equal(service.rejectLetter, undefined);
  assert.equal(service.submitDeanDecision, undefined);
});

test('Professor identity lookup calls the scoped encrypted-data endpoint', async () => {
  const identity = { full_name: 'Jordan Lee', student_number: '2024-0123' };
  const { service, queries, secureCalls } = makeClient({
    secureResults: { 'professor-identity': identity },
  });

  assert.deepEqual(await service.getProfessorLetterStudentIdentity(approvedLetter.id), identity);
  assert.deepEqual(secureCalls, [{
    action: 'professor-identity',
    params: { letterId: approvedLetter.id },
  }]);
  const profileQueries = queries.filter((query) => query.table === 'profiles');
  assert.equal(profileQueries.length, 1);
  assert.equal(profileQueries[0].selection, 'role');
});

test('Professor identity lookup safely returns null when the letter is not accessible', async () => {
  const notFound = new Error('not found');
  notFound.status = 404;
  const { service, secureCalls } = makeClient({
    secureErrors: { 'professor-identity': notFound },
  });

  assert.equal(await service.getProfessorLetterStudentIdentity(approvedLetter.id), null);
  assert.equal(secureCalls.length, 1);
});

test('Professor identity API errors propagate and the caller can retry the lookup', async () => {
  const failure = { code: '42501', message: 'not authorized' };
  const identity = { full_name: 'Jordan Lee', student_number: '2024-0123' };
  const { service, secureCalls, secureErrors } = makeClient({
    secureErrors: { 'professor-identity': failure },
    secureResults: { 'professor-identity': identity },
  });

  await assert.rejects(service.getProfessorLetterStudentIdentity(approvedLetter.id), (error) => error === failure);
  delete secureErrors['professor-identity'];
  assert.deepEqual(await service.getProfessorLetterStudentIdentity(approvedLetter.id), identity);
  assert.equal(secureCalls.length, 2);
  assert.ok(secureCalls.every((call) => call.params.letterId === approvedLetter.id));
});

test('Professor table identity state exposes successful RPC fields and rejects stale updates', () => {
  const identity = { full_name: 'Joaquin Manalastas', student_number: '2024000993' };
  const initialState = { accountId: null, byLetterId: {} };
  const readyState = updateProfessorIdentityState(initialState, {
    letterId: approvedLetter.id,
    accountId: professorId,
    requestId: 1,
    status: 'ready',
    identity,
  });
  const tableIdentities = getProfessorIdentityStatesForAccount(readyState, professorId);

  assert.equal(tableIdentities[approvedLetter.id].status, 'ready');
  assert.equal(tableIdentities[approvedLetter.id].identity.full_name, identity.full_name);
  assert.equal(tableIdentities[approvedLetter.id].identity.student_number, identity.student_number);
  assert.equal(getProfessorIdentityStatesForAccount(readyState, otherProfessorId)[approvedLetter.id], undefined);

  const withUnavailableLetter = updateProfessorIdentityState(readyState, {
    letterId: 'letter-without-identity',
    accountId: professorId,
    requestId: 2,
    status: 'unavailable',
    identity: null,
  });
  assert.equal(
    getProfessorIdentityStatesForAccount(withUnavailableLetter, professorId)['letter-without-identity'].status,
    'unavailable',
  );

  const withLoadingSecondLetter = updateProfessorIdentityState(readyState, {
    letterId: 'letter-second',
    accountId: professorId,
    requestId: 1,
    status: 'loading',
    identity: null,
  });
  assert.equal(Object.keys(getProfessorIdentityStatesForAccount(withLoadingSecondLetter, professorId)).length, 2);
  assert.equal(getProfessorIdentityStatesForAccount(withLoadingSecondLetter, professorId)[approvedLetter.id].status, 'ready');

  const errorState = updateProfessorIdentityState(withLoadingSecondLetter, {
    letterId: 'letter-second',
    accountId: professorId,
    requestId: 1,
    status: 'error',
    identity: null,
  });
  const retryLoadingState = updateProfessorIdentityState(errorState, {
    letterId: 'letter-second',
    accountId: professorId,
    requestId: 2,
    status: 'loading',
    identity: null,
  });
  const retryReadyState = updateProfessorIdentityState(retryLoadingState, {
    letterId: 'letter-second',
    accountId: professorId,
    requestId: 2,
    status: 'ready',
    identity: { full_name: 'Another Student', student_number: '2024000002' },
  });
  assert.equal(getProfessorIdentityStatesForAccount(retryReadyState, professorId)['letter-second'].status, 'ready');

  assert.equal(updateProfessorIdentityState(retryReadyState, {
    letterId: approvedLetter.id,
    accountId: otherProfessorId,
    requestId: 4,
    status: 'ready',
    identity: { full_name: 'Stale Account', student_number: '0' },
  }), retryReadyState);
  assert.equal(updateProfessorIdentityState(retryReadyState, {
    letterId: 'letter-second',
    accountId: professorId,
    requestId: 1,
    status: 'error',
    identity: null,
  }), retryReadyState);
});

test('Professor identity cells render the authorized name, number, unavailable, and retry states', () => {
  const identityState = {
    status: 'ready',
    identity: { full_name: 'Joaquin Manalastas', student_number: '2024000993' },
  };
  assert.equal(
    renderToStaticMarkup(React.createElement(ProfessorIdentityCell, { identityState, field: 'full_name' })),
    'Joaquin Manalastas',
  );
  assert.equal(
    renderToStaticMarkup(React.createElement(ProfessorIdentityCell, { identityState, field: 'student_number' })),
    '2024000993',
  );
  assert.match(
    renderToStaticMarkup(React.createElement(ProfessorIdentityCell, {
      identityState: { status: 'unavailable', identity: null },
      field: 'full_name',
    })),
    /Unavailable/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(ProfessorIdentityCell, {
      identityState: { status: 'error', identity: null },
      field: 'full_name',
      letterId: approvedLetter.id,
      onRetry() {},
    })),
    /Could not load[\s\S]*Retry/,
  );
  let retriedLetterId;
  const errorCell = ProfessorIdentityCell({
    identityState: { status: 'error', identity: null },
    field: 'full_name',
    letterId: approvedLetter.id,
    onRetry: (letterId) => { retriedLetterId = letterId; },
  });
  errorCell.props.children[1].props.onClick();
  assert.equal(retriedLetterId, approvedLetter.id);
});

test('a non-Professor cannot call Professor data queries', async () => {
  const { service, queries } = makeClient({ role: 'dean' });

  await assert.rejects(service.getProfessorCourses(), /Only an authenticated Professor/);
  assert.equal(queries.some((query) => query.table === 'course_offerings'), false);
});

test('an unauthenticated user cannot call Professor data queries', async () => {
  const { service } = makeClient({ userId: null });

  await assert.rejects(service.getProfessorCourses(), /You must be signed in/);
});

test('Supabase errors are propagated instead of replaced with placeholder records', async () => {
  const failure = { code: 'XX000', message: 'query failed' };
  const { service } = makeClient({ errors: { course_offerings: failure } });

  await assert.rejects(service.getProfessorCourses(), (error) => error === failure);
});

test('evidence access errors remain visible to the caller', async () => {
  const failure = { code: '42501', message: 'evidence access denied' };
  const { service } = makeClient({
    secureErrors: { 'professor-evidence': failure },
  });

  await assert.rejects(service.getProfessorEvidence(approvedLetter.id), (error) => error === failure);
});

test('approved evidence receives a short-lived private signed link', async () => {
  const evidence = { id: 'evidence-1', letter_id: approvedLetter.id, storage_path: `${professorId}/${approvedLetter.id}/private.pdf` };
  const { service, signedUrlRequests } = makeClient({
    data: {
      excuse_evidence: [evidence],
      excuse_letters: [{ id: approvedLetter.id, status: 'approved' }],
    },
  });

  assert.match(await service.getProfessorEvidenceSignedUrl(evidence.id), /private\.pdf/);
  assert.deepEqual(signedUrlRequests, [{
    bucket: 'excuse-evidence',
    path: evidence.storage_path,
    expiresIn: 60,
  }]);
});

test('non-Professors and Students cannot request Professor signed evidence URLs', async (t) => {
  for (const role of ['student', 'dean']) {
    await t.test(role, async () => {
      const { service, queries, signedUrlRequests } = makeClient({ role });

      await assert.rejects(service.getProfessorEvidenceSignedUrl('evidence-1'), /Only an authenticated Professor/);
      assert.equal(queries.some((query) => query.table === 'excuse_evidence'), false);
      assert.deepEqual(signedUrlRequests, []);
    });
  }
});

test('unassigned Professor, pending, rejected, and unrelated evidence cannot produce signed URLs', async (t) => {
  const pendingLetter = { id: 'letter-pending', status: 'pending' };
  const rejectedLetter = { id: 'letter-rejected', status: 'disapproved' };
  const pendingEvidence = {
    id: 'evidence-pending',
    letter_id: pendingLetter.id,
    storage_path: `${professorId}/${pendingLetter.id}/pending.pdf`,
  };
  const rejectedEvidence = {
    id: 'evidence-rejected',
    letter_id: rejectedLetter.id,
    storage_path: `${professorId}/${rejectedLetter.id}/rejected.pdf`,
  };
  const deniedCases = [
    { name: 'unassigned Professor', userId: otherProfessorId, evidenceId: 'evidence-unassigned', data: { excuse_evidence: [] } },
    {
      name: 'pending letter',
      evidenceId: pendingEvidence.id,
      data: { excuse_evidence: [pendingEvidence], excuse_letters: [pendingLetter] },
    },
    {
      name: 'rejected letter',
      evidenceId: rejectedEvidence.id,
      data: { excuse_evidence: [rejectedEvidence], excuse_letters: [rejectedLetter] },
    },
    { name: 'unrelated evidence', evidenceId: 'evidence-unrelated', data: { excuse_evidence: [] } },
  ];

  for (const deniedCase of deniedCases) {
    await t.test(deniedCase.name, async () => {
      const { service, signedUrlRequests } = makeClient({
        role: 'professor',
        userId: deniedCase.userId || professorId,
        data: deniedCase.data,
      });

      await assert.rejects(
        service.getProfessorEvidenceSignedUrl(deniedCase.evidenceId),
        /not found or is not accessible/,
      );
      assert.deepEqual(signedUrlRequests, []);
    });
  }
});

test('Professor identity migration restricts output, authorization, and function privileges', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20261110120000_professor_approved_letter_student_identity.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /FUNCTION public\.get_professor_approved_letter_student_identity\(\s*p_letter_id uuid\s*\)/);
  assert.match(migration, /RETURNS TABLE \(\s*full_name text,\s*student_number text\s*\)/);
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(migration, /professor\.id = \(SELECT auth\.uid\(\)\)\s+AND professor\.role = 'professor'/);
  assert.match(migration, /student\.id = letter\.student_id\s+AND student\.role = 'student'/);
  assert.match(migration, /letter\.status = 'approved'/);
  assert.match(migration, /course\.professor_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /OWNER TO postgres/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /TO authenticated/);
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]*TO service_role/i);
  assert.doesNotMatch(migration, /CREATE POLICY|DROP POLICY|ALTER POLICY/i);
});

test('Professor evidence migration adds restrictive role and relationship checks without replacing existing policies', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20261110130000_professor_evidence_access_and_course_rls.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /FUNCTION securitres_private\.can_student_access_course\(p_course_id uuid\)/);
  assert.match(migration, /current_profile_role\(\)\) = 'student'[\s\S]*FROM public\.course_enrollments/);
  assert.match(migration, /FUNCTION securitres_private\.can_dean_access_course\(p_course_id uuid\)/);
  assert.match(migration, /securitres_private\.can_dean_access_letter\(letter\.id\)/);
  for (const helper of ['can_student_access_course', 'can_dean_access_course']) {
    assert.match(migration, new RegExp(`FUNCTION securitres_private\\.${helper}\\(p_course_id uuid\\)[\\s\\S]*?SECURITY DEFINER\\s+SET search_path = ''`));
    assert.match(migration, new RegExp(`ALTER FUNCTION securitres_private\\.${helper}\\(uuid\\)\\s+OWNER TO postgres`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION securitres_private\\.${helper}\\(uuid\\)[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION securitres_private\\.${helper}\\(uuid\\)\\s+TO authenticated`));
  }
  assert.match(
    migration,
    /CREATE POLICY course_enrollments_select_authorized_scope\s+ON public\.course_enrollments\s+AS RESTRICTIVE\s+FOR SELECT TO authenticated\s+USING\s*\([\s\S]*?\(SELECT public\.current_profile_role\(\)\) = 'student'\s+AND student_id = \(SELECT auth\.uid\(\)\)[\s\S]*?\(SELECT public\.current_profile_role\(\)\) = 'professor'\s+AND EXISTS \([\s\S]*?FROM public\.course_offerings AS course\s+WHERE course\.id = public\.course_enrollments\.course_id\s+AND course\.professor_id = \(SELECT auth\.uid\(\)\)/,
  );
  assert.match(migration, /course_offerings_select_authorized_scope[\s\S]*AS RESTRICTIVE[\s\S]*current_profile_role\(\)\) = 'professor'[\s\S]*professor_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /evidence_select_authorized_role_scope[\s\S]*AS RESTRICTIVE[\s\S]*current_profile_role\(\)\) = 'professor'[\s\S]*letter\.status = 'approved'[\s\S]*course\.professor_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /users_download_evidence_authorized_role_scope[\s\S]*AS RESTRICTIVE[\s\S]*bucket_id <> 'excuse-evidence'[\s\S]*evidence\.storage_path = objects\.name[\s\S]*current_profile_role\(\)\) = 'professor'[\s\S]*letter\.status = 'approved'[\s\S]*course\.professor_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /current_profile_role\(\)\) = 'student'[\s\S]*letter\.student_id = \(SELECT auth\.uid\(\)\)/);
  assert.match(migration, /securitres_private\.can_dean_access_letter\(letter\.id\)/);
  assert.doesNotMatch(migration, /DROP POLICY|ALTER POLICY/i);
});

test('Professor UI has explicit loading, failure, empty, read-only, and identity-limitation states', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const identityCell = await readFile(new URL('../src/components/ProfessorIdentityCell.js', import.meta.url), 'utf8');
  const identityState = await readFile(new URL('../src/utils/professorIdentityState.js', import.meta.url), 'utf8');
  const service = await readFile(new URL('../src/services/professorLetters.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(app, /Loading assigned courses/);
  assert.match(app, /Loading approved letters/);
  assert.match(app, /No courses are assigned to your account/);
  assert.match(app, /no approved excuse letters yet/);
  assert.match(app, /Evidence could not be loaded/);
  assert.match(app, /Student identity is unavailable for this letter/);
  assert.match(app, /Retry identity lookup/);
  assert.match(app, /professorStudentIdentity\.full_name/);
  assert.match(app, /professorStudentIdentity\.student_number/);
  assert.match(app, /<th>Student Name<\/th><th>Student Number<\/th>/);
  assert.match(app, /ProfessorIdentityCell identityState=\{professorIdentities\[letter\.id\]\} field="full_name"/);
  assert.match(app, /ProfessorIdentityCell identityState=\{professorIdentities\[letter\.id\]\} field="student_number"/);
  assert.match(app, /items=\{dashboardLetters\.slice\(0, 5\)\}[\s\S]*?professorIdentities=\{professorTableIdentityByLetterId\}[\s\S]*?onRetryProfessorIdentity=\{retryProfessorTableIdentity\}/);
  assert.match(app, /items=\{professorFilteredLetters\}[\s\S]*?professorIdentities=\{professorTableIdentityByLetterId\}[\s\S]*?onRetryProfessorIdentity=\{retryProfessorTableIdentity\}/);
  assert.match(app, /useEffect\(\(\) => \{\s*let active = true;\s*const accountId = profileRole === 'professor' \? authUser\?\.id \|\| null : null;\s*professorTableIdentityAccountId\.current = accountId;/);
  assert.match(app, /professorLetters\.forEach\(\(letter\) => \{\s*void requestProfessorTableIdentity\(letter\.id, accountId, \(\) => active\)/);
  assert.match(app, /\}, \[authUser\?\.id, profileRole, professorLetters, professorLettersStatus\]\);/);
  assert.match(app, /function retryProfessorTableIdentity\(letterId\)/);
  assert.match(app, /professorTableIdentityRequestIds\.current\[letterId\] !== requestId/);
  assert.match(app, /professorTableIdentityAccountId\.current !== accountId/);
  assert.match(app, /updateProfessorIdentityState\(current,/);
  assert.match(app, /getProfessorIdentityStatesForAccount\(/);
  assert.match(identityState, /current\.accountId === null && Object\.keys\(current\.byLetterId\)\.length === 0/);
  assert.match(identityState, /requestId < currentRequestId/);
  assert.match(identityCell, /identityState\.identity\?\.\[field\]/);
  assert.match(app, /ProfessorIdentityCell identityState=\{professorIdentities\[letter\.id\]\} field="full_name"/);
  assert.match(app, /ProfessorIdentityCell identityState=\{professorIdentities\[letter\.id\]\} field="student_number"/);
  assert.match(identityState, /if \(!sameAccount && !uninitialized\) return current/);
  assert.match(identityState, /if \(currentRequestId != null && requestId < currentRequestId\) return current/);
  assert.doesNotMatch(app, /setProfessorTableIdentities\(\(current\) => current\.accountId !== accountId\s*\?/);
  assert.doesNotMatch(app, /professorTableIdentityAccountId\.current = profileRole === 'professor'/);
  assert.match(identityCell, /Loading…[\s\S]*?Could not load[\s\S]*?onRetry\(letterId\)[\s\S]*?Unavailable/);
  assert.match(app, /getProfessorIdentityStatesForAccount\(\s*professorTableIdentities,\s*authUser\?\.id/);
  assert.match(styles, /\.professor-table-wrap \{ max-width: 100%; \}/);
  assert.match(styles, /\.professor-letters-table \{ min-width: 980px; table-layout: fixed; \}/);
  assert.match(app, /Read-only view\. Decisions remain with the Dean/);
  assert.match(app, /getProfessorLetterDetails\(id\)/);
  assert.match(app, /getProfessorLetterStudentIdentity\(letterId\)/);
  assert.doesNotMatch(service, /\.from\(['"]profiles['"]\)\s*\.select\(['"][^'"]*(?:full_name|student_number)/);
  assert.doesNotMatch(service, /\.from\(['"](?:excuse_letters|excuse_evidence|profiles)['"]\)\s*\.(?:insert|update|delete)\(/);
  assert.doesNotMatch(service, /\.rpc\(['"](?:decide_excuse_letter|notify-student-decision)/);
});
