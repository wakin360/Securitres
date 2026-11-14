import { randomUUID } from 'node:crypto';
import {
  ApiError,
  authenticateRequest,
  decryptLetter,
  decryptLetterEvents,
  decryptLetterEventRows,
  decryptProfile,
  decryptText,
  encryptText,
  getAuthorizedLetter,
  getProfile,
  getEncryptionMode,
  requireRole,
  respondWithError,
  sendJson,
} from './_lib/secure-data.js';
import { createStudentNumberIndex } from './_lib/student-number-index.js';

const pageSize = 500;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const courseFields = 'id, course_code, course_name, section';
const profileFields = 'id, role, program_id, full_name, full_name_envelope, student_number, student_number_envelope, program, program_envelope';
const evidenceFields = 'id, letter_id, storage_path, original_filename, original_filename_envelope, mime_type, size_bytes, uploaded_at';
const deanResourceUnavailableMessage = 'Dean resource is not available.';
const evidenceSignedUrlLifetimeSeconds = 60;

function decryptContact(contact, letterId) {
  if (!contact) return null;
  return {
    parent_guardian_phone: decryptText(
      contact.parent_guardian_phone_envelope,
      contact.parent_guardian_phone,
      'excuse_letter_contacts',
      letterId,
      'parent_guardian_phone',
    ),
  };
}

function decryptEvidence(evidence) {
  return {
    id: evidence.id,
    original_filename: decryptText(
      evidence.original_filename_envelope,
      evidence.original_filename,
      'excuse_evidence',
      evidence.id,
      'original_filename',
    ),
    mime_type: evidence.mime_type,
    size_bytes: evidence.size_bytes,
    uploaded_at: evidence.uploaded_at,
  };
}

function decryptDeanRelations(letter) {
  if (letter.student) {
    const student = letter.student;
    letter.student = {
      full_name: decryptText(
        student.full_name_envelope,
        student.full_name,
        'profiles',
        student.id,
        'full_name',
      ),
      student_number: decryptText(
        student.student_number_envelope,
        student.student_number,
        'profiles',
        student.id,
        'student_number',
      ),
      program: decryptText(
        student.program_envelope,
        student.program,
        'profiles',
        student.id,
        'program',
      ),
    };
  }
  if (letter.course?.professor) {
    const professor = letter.course.professor;
    letter.course.professor = {
      full_name: decryptText(
        professor.full_name_envelope,
        professor.full_name,
        'profiles',
        professor.id,
        'full_name',
      ),
    };
  }
  letter.contact = decryptContact(letter.contact, letter.id);
  return letter;
}

function decryptDeanLetter(letter) {
  const result = decryptDeanRelations(decryptLetter(letter, true));
  if (Array.isArray(letter.statusEvents)) {
    result.statusEvents = decryptLetterEventRows(letter.statusEvents);
  }
  if (Array.isArray(letter.evidence)) {
    result.evidence = letter.evidence.map(decryptEvidence);
  }
  return result;
}

function throwDeanReadError(error) {
  if (error?.code === 'P0001'
      && error.message === deanResourceUnavailableMessage) {
    throw new ApiError(404, 'The letter was not found or is not accessible.');
  }
  throw error;
}

async function callDeanReadRpc(supabase, functionName, args) {
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) throwDeanReadError(error);
  return data || [];
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

async function selectLetters(supabase, selection, filter, orderColumn) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from('excuse_letters').select(selection);
    query = filter(query);
    const { data, error } = await query
      .order(orderColumn, { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

async function getStudentLetters(supabase, userId, letterId) {
  const selection = `
    id, student_id, course_id,
    absence_start, absence_start_envelope,
    absence_end, absence_end_envelope,
    reason, reason_envelope,
    status, dean_comment, dean_comment_envelope,
    submitted_at, decided_at, decided_by, created_at,
    course_offerings (id, course_code, course_name, section),
    contact:excuse_letter_contacts!excuse_letter_contacts_letter_id_fkey (
      parent_guardian_phone, parent_guardian_phone_envelope
    )
  `;

  if (letterId) {
    const { data: letter, error } = await supabase
      .from('excuse_letters')
      .select(selection)
      .eq('id', letterId)
      .eq('student_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!letter) throw new ApiError(404, 'The letter was not found or is not accessible.');
    const result = decryptLetter(letter, true);
    result.contact = decryptContact(letter.contact, letter.id);
    result.statusEvents = await decryptLetterEvents(supabase, letter.id);
    return result;
  }

  const letters = await selectLetters(
    supabase,
    selection,
    (query) => query.eq('student_id', userId),
    'created_at',
  );
  return letters.map((letter) => {
    const result = decryptLetter(letter, true);
    result.contact = decryptContact(letter.contact, letter.id);
    return result;
  });
}

export async function getDeanLetters(supabase, deanId, letterId) {
  if (letterId) {
    const [letter] = await callDeanReadRpc(supabase, 'get_dean_letters_encrypted', {
      p_dean_id: deanId,
      p_letter_id: letterId,
      p_limit: 1,
      p_offset: 0,
    });
    if (!letter) {
      throw new ApiError(404, 'The letter was not found or is not accessible.');
    }
    return decryptDeanLetter(letter);
  }

  const letters = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await callDeanReadRpc(supabase, 'get_dean_letters_encrypted', {
      p_dean_id: deanId,
      p_letter_id: null,
      p_limit: pageSize,
      p_offset: offset,
    });
    letters.push(...page.map(decryptDeanLetter));
    if (page.length < pageSize) return letters;
  }
}

export async function getDeanEvidence(supabase, deanId, letterId) {
  const evidence = await callDeanReadRpc(supabase, 'get_dean_evidence_encrypted', {
    p_dean_id: deanId,
    p_letter_id: letterId,
  });
  return evidence.map(decryptEvidence);
}

async function getDeanEvidenceSignedUrl(supabase, userSupabase, deanId, evidenceId) {
  const storagePath = await callDeanReadRpc(supabase, 'get_dean_evidence_storage_path', {
    p_dean_id: deanId,
    p_evidence_id: evidenceId,
  });
  if (typeof storagePath !== 'string' || !storagePath) {
    throw new ApiError(404, 'The evidence was not found or is not accessible.');
  }

  const { data, error } = await userSupabase.storage
    .from('excuse-evidence')
    .createSignedUrl(storagePath, evidenceSignedUrlLifetimeSeconds);
  if (error) throw error;
  if (typeof data?.signedUrl !== 'string' || !data.signedUrl) {
    throw new ApiError(502, 'The evidence link could not be generated.');
  }
  return data.signedUrl;
}

async function getProfessorLetters(supabase, professorId, letterId) {
  const { data: courses, error: coursesError } = await supabase
    .from('course_offerings')
    .select(courseFields)
    .eq('professor_id', professorId);
  if (coursesError) throw coursesError;
  const courseIds = (courses || []).map(({ id }) => id);
  if (letterId) {
    const letter = await getAuthorizedLetter(supabase, { id: professorId }, letterId, 'professor');
    const selection = `
      id, course_id, student_id,
      absence_start, absence_start_envelope,
      absence_end, absence_end_envelope,
      reason, reason_envelope,
      status, submitted_at, decided_at,
      course:course_offerings!excuse_letters_course_id_fkey (${courseFields})
    `;
    const { data, error } = await supabase
      .from('excuse_letters')
      .select(selection)
      .eq('id', letter.id)
      .single();
    if (error) throw error;
    return decryptLetter(data, false);
  }
  if (!courseIds.length) return [];

  const selection = `
    id, course_id, student_id,
    absence_start, absence_start_envelope,
    absence_end, absence_end_envelope,
    reason, reason_envelope,
    status, submitted_at, decided_at,
    course:course_offerings!excuse_letters_course_id_fkey (${courseFields})
  `;
  return selectLetters(
    supabase,
    selection,
    (query) => query.in('course_id', courseIds).eq('status', 'approved'),
    'decided_at',
  ).then((letters) => letters.map((letter) => decryptLetter(letter, false)));
}

async function getAuthorizedEvidence(supabase, profile, role, letterId) {
  const letter = await getAuthorizedLetter(supabase, profile, letterId, role);
  const { data, error } = await supabase
    .from('excuse_evidence')
    .select(evidenceFields)
    .eq('letter_id', letter.id)
    .order('uploaded_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(decryptEvidence);
}

async function handleRead(req, res, supabase, userSupabase, user, profile) {
  const action = req.query.action;
  const letterId = typeof req.query.letterId === 'string' ? req.query.letterId : null;
  if (letterId && !uuidPattern.test(letterId)) throw new ApiError(400, 'A valid letter ID is required.');

  if (action === 'profile') {
    const encryptionMode = getEncryptionMode();
    const pendingEnvelopes = {};
    let expectedStudentNumberIndex = null;
    const plaintextSnapshot = {
      full_name: profile.full_name,
      student_number: profile.student_number,
      program: profile.program,
    };
    const initiallyDecrypted = decryptProfile(profile);
    for (const field of Object.keys(plaintextSnapshot)) {
      if (plaintextSnapshot[field] !== null
          && plaintextSnapshot[field] !== undefined
          && initiallyDecrypted[field] !== plaintextSnapshot[field]) {
        throw new ApiError(503, 'Stored profile encryption could not be verified.');
      }
    }
    for (const [field, envelopeField] of [
      ['full_name', 'full_name_envelope'],
      ['student_number', 'student_number_envelope'],
      ['program', 'program_envelope'],
    ]) {
      if (encryptionMode === 'legacy' && !profile[envelopeField] && profile[field] !== null) {
        pendingEnvelopes[envelopeField] = encryptText(profile[field], 'profiles', profile.id, field);
      }
    }
    const currentStudentNumber = decryptText(
      pendingEnvelopes.student_number_envelope || profile.student_number_envelope,
      pendingEnvelopes.student_number_envelope ? null : profile.student_number,
      'profiles',
      profile.id,
      'student_number',
    );
    if (currentStudentNumber !== null) {
      expectedStudentNumberIndex = createStudentNumberIndex(currentStudentNumber);
      if (profile.student_number_index
          && profile.student_number_index !== expectedStudentNumberIndex) {
        throw new ApiError(503, 'Student-number uniqueness protection could not be verified.');
      }
    }
    for (const [field, envelopeField] of [
      ['full_name', 'full_name_envelope'],
      ['student_number', 'student_number_envelope'],
      ['program', 'program_envelope'],
    ]) {
      if (!pendingEnvelopes[envelopeField]) continue;
      const { error } = await supabase
        .from('profiles')
        .update({ [envelopeField]: pendingEnvelopes[envelopeField] })
        .eq('id', profile.id)
        .eq(field, plaintextSnapshot[field])
        .is(envelopeField, null);
      if (error) throw error;
    }
    if (expectedStudentNumberIndex && !profile.student_number_index) {
      let indexUpdate = supabase
        .from('profiles')
        .update({ student_number_index: expectedStudentNumberIndex })
        .eq('id', profile.id)
        .is('student_number_index', null);
      indexUpdate = profile.student_number !== null && profile.student_number !== undefined
        ? indexUpdate
          .eq('student_number', profile.student_number)
          .eq(
            'student_number_envelope',
            JSON.stringify(pendingEnvelopes.student_number_envelope || profile.student_number_envelope),
          )
        : indexUpdate.eq(
          'student_number_envelope',
          JSON.stringify(pendingEnvelopes.student_number_envelope || profile.student_number_envelope),
        );
      const { error } = await indexUpdate;
      if (error) throw error;
    }
    const refreshedProfile = await getProfile(supabase, profile.id);
    if (expectedStudentNumberIndex
        && refreshedProfile.student_number_index !== expectedStudentNumberIndex) {
      throw new ApiError(503, 'Student-number uniqueness protection could not be verified.');
    }
    if (expectedStudentNumberIndex
        && createStudentNumberIndex(decryptText(
          refreshedProfile.student_number_envelope,
          refreshedProfile.student_number,
          'profiles',
          profile.id,
          'student_number',
        )) !== refreshedProfile.student_number_index) {
      throw new ApiError(503, 'Student-number uniqueness protection could not be verified.');
    }
    const decryptedProfile = decryptProfile(refreshedProfile);
    for (const field of Object.keys(plaintextSnapshot)) {
      if (plaintextSnapshot[field] !== null
          && decryptedProfile[field] !== plaintextSnapshot[field]) {
        throw new ApiError(503, 'Stored profile encryption could not be verified.');
      }
    }

    const finalProfile = await getProfile(supabase, profile.id);
    return sendJson(res, 200, decryptProfile(finalProfile));
  }
  if (action === 'student-letters') {
    requireRole(profile, 'student');
    return sendJson(res, 200, await getStudentLetters(supabase, user.id, letterId));
  }
  if (action === 'dean-letters') {
    requireRole(profile, 'dean');
    return sendJson(res, 200, await getDeanLetters(supabase, user.id, letterId));
  }
  if (action === 'dean-evidence-url') {
    requireRole(profile, 'dean');
    const evidenceId = req.query.evidenceId;
    if (typeof evidenceId !== 'string' || !uuidPattern.test(evidenceId)) {
      throw new ApiError(400, 'A valid evidence ID is required.');
    }
    const signedUrl = await getDeanEvidenceSignedUrl(
      supabase,
      userSupabase,
      user.id,
      evidenceId,
    );
    return sendJson(res, 200, { signedUrl });
  }
  if (action === 'professor-letters') {
    requireRole(profile, 'professor');
    return sendJson(res, 200, await getProfessorLetters(supabase, user.id, letterId));
  }
  if (action === 'professor-identity') {
    requireRole(profile, 'professor');
    if (!letterId || !uuidPattern.test(letterId)) throw new ApiError(400, 'A valid letter ID is required.');
    const letter = await getAuthorizedLetter(supabase, profile, letterId, 'professor');
    const { data: student, error } = await supabase
      .from('profiles')
      .select(profileFields)
      .eq('id', letter.student_id)
      .maybeSingle();
    if (error) throw error;
    if (!student) throw new ApiError(404, 'Student identity is unavailable.');
    const identity = decryptProfile(student);
    return sendJson(res, 200, {
      full_name: identity.full_name,
      student_number: identity.student_number,
    });
  }
  if (action === 'student-evidence' || action === 'dean-evidence' || action === 'professor-evidence') {
    const role = action.split('-')[0];
    requireRole(profile, role);
    if (!letterId || !uuidPattern.test(letterId)) throw new ApiError(400, 'A valid letter ID is required.');
    if (role === 'dean') {
      return sendJson(res, 200, await getDeanEvidence(supabase, user.id, letterId));
    }
    return sendJson(res, 200, await getAuthorizedEvidence(supabase, profile, role, letterId));
  }

  throw new ApiError(400, 'Unknown encrypted-data request.');
}

async function handleStudentLetter(body, supabase, user, profile) {
  requireRole(profile, 'student');
  const { courseId, absenceStart, absenceEnd, reason, parentGuardianPhone } = body || {};
  if (typeof courseId !== 'string'
      || !uuidPattern.test(courseId)
      || typeof absenceStart !== 'string'
      || typeof absenceEnd !== 'string'
      || !isIsoDate(absenceStart)
      || !isIsoDate(absenceEnd)
      || absenceEnd < absenceStart
      || typeof reason !== 'string'
      || !reason.trim()
      || typeof parentGuardianPhone !== 'string'
      || !parentGuardianPhone.trim()
      || parentGuardianPhone.trim().length > 40) {
    throw new ApiError(400, 'Complete the course, absence dates, reason, and parent/guardian phone fields.');
  }

  const letterId = randomUUID();
  const args = {
    p_letter_id: letterId,
    p_student_id: user.id,
    p_course_id: courseId,
    p_absence_start_envelope: encryptText(absenceStart, 'excuse_letters', letterId, 'absence_start'),
    p_absence_end_envelope: encryptText(absenceEnd, 'excuse_letters', letterId, 'absence_end'),
    p_reason_envelope: encryptText(reason, 'excuse_letters', letterId, 'reason'),
    p_parent_guardian_phone_envelope: encryptText(
      parentGuardianPhone.trim(),
      'excuse_letter_contacts',
      letterId,
      'parent_guardian_phone',
    ),
  };
  const { data, error } = await supabase.rpc('create_student_excuse_letter_encrypted', args);
  if (error) throw error;
  return data?.[0] || data;
}

async function handleDeanDecision(body, supabase, user, profile) {
  requireRole(profile, 'dean');
  const letterId = body?.letterId;
  const decision = body?.decision;
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : '';
  if (typeof letterId !== 'string'
      || !uuidPattern.test(letterId)
      || !['approved', 'disapproved'].includes(decision)) {
    throw new ApiError(400, 'A valid letter ID and decision are required.');
  }
  const eventId = randomUUID();
  const args = {
    p_dean_id: user.id,
    p_letter_id: letterId,
    p_decision: decision,
    p_event_id: eventId,
    p_dean_comment_envelope: encryptText(comment || null, 'excuse_letters', letterId, 'dean_comment'),
    p_event_comment_envelope: encryptText(comment || null, 'letter_status_events', eventId, 'comment'),
  };
  const { data, error } = await supabase.rpc('decide_excuse_letter_encrypted', args);
  if (error?.code === '42501') {
    throw new ApiError(404, 'The letter was not found or is not accessible.');
  }
  if (error?.code === 'P0001'
      && error.message === 'Letter was not found or is no longer pending.') {
    throw new ApiError(409, 'This letter is no longer pending review.');
  }
  if (error) throw error;
  return data?.[0] || data;
}

async function handleEvidenceMetadata(body, supabase, user, profile) {
  requireRole(profile, 'student');
  const { letterId, storagePath, originalFilename, mimeType, sizeBytes } = body || {};
  if (typeof letterId !== 'string'
      || !uuidPattern.test(letterId)
      || typeof storagePath !== 'string'
      || typeof originalFilename !== 'string'
      || !originalFilename.trim()
      || typeof mimeType !== 'string'
      || !['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)
      || !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 1
      || sizeBytes > 8 * 1024 * 1024) {
    throw new ApiError(400, 'Evidence metadata is invalid.');
  }
  const letter = await getAuthorizedLetter(supabase, profile, letterId, 'student');
  if (letter.status !== 'pending') throw new ApiError(403, 'Evidence can only be attached to a pending letter.');

  const evidenceId = randomUUID();
  const { data, error } = await supabase.rpc('create_student_evidence_record_encrypted', {
    p_evidence_id: evidenceId,
    p_student_id: user.id,
    p_letter_id: letter.id,
    p_storage_path: storagePath,
    p_original_filename_envelope: encryptText(
      originalFilename,
      'excuse_evidence',
      evidenceId,
      'original_filename',
    ),
    p_mime_type: mimeType,
    p_size_bytes: sizeBytes,
  });
  if (error) throw error;
  return decryptEvidence(data?.[0] || data);
}

export default async function handler(req, res) {
  try {
    const { user, supabase, userSupabase } = await authenticateRequest(req);
    const profile = await getProfile(supabase, user.id);
    if (req.method === 'GET') {
      return await handleRead(req, res, supabase, userSupabase, user, profile);
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }

    if (req.body?.action === 'create-student-letter') {
      return sendJson(res, 201, await handleStudentLetter(req.body, supabase, user, profile));
    }
    if (req.body?.action === 'decide-letter') {
      return sendJson(res, 200, await handleDeanDecision(req.body, supabase, user, profile));
    }
    if (req.body?.action === 'create-evidence-metadata') {
      return sendJson(res, 201, await handleEvidenceMetadata(req.body, supabase, user, profile));
    }
    throw new ApiError(400, 'Unknown encrypted-data request.');
  } catch (error) {
    return respondWithError(res, error);
  }
}
