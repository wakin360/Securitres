CREATE TABLE public.student_decision_notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  letter_id uuid NOT NULL REFERENCES public.excuse_letters (id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (notification_type IN ('approved', 'disapproved')),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  claim_token uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  last_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  sent_at timestamptz,
  error_code text CHECK (error_code IS NULL OR pg_catalog.length(error_code) <= 64),
  CONSTRAINT student_decision_notifications_letter_type_key
    UNIQUE (letter_id, notification_type),
  CONSTRAINT student_decision_notifications_state_consistency CHECK (
    (status = 'sending' AND claim_token IS NOT NULL AND sent_at IS NULL AND error_code IS NULL)
    OR (status = 'sent' AND claim_token IS NULL AND sent_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND claim_token IS NULL AND sent_at IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX student_decision_notifications_student_created_idx
  ON public.student_decision_notifications (student_id, created_at DESC);

ALTER TABLE public.student_decision_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_decision_notifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (letter_id, notification_type, status, attempt_count, last_attempt_at, sent_at, error_code)
  ON public.student_decision_notifications TO authenticated;

CREATE POLICY student_decision_notifications_select_own_dean_decisions
  ON public.student_decision_notifications FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.id = student_decision_notifications.letter_id
        AND letter.decided_by = (SELECT auth.uid())
        AND securitres_private.can_dean_access_letter(letter.id)
    )
  );

CREATE FUNCTION public.claim_student_decision_notification(
  p_letter_id uuid,
  p_dean_id uuid
)
RETURNS TABLE (
  outcome text,
  student_name text,
  recipient_email text,
  submitted_at timestamptz,
  decided_at timestamptz,
  decision text,
  dean_comment text,
  claim_token uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_student_id uuid;
  v_program_id uuid;
  v_status text;
  v_student_name text;
  v_email text;
  v_email_confirmed boolean;
  v_submitted_at timestamptz;
  v_decided_at timestamptz;
  v_dean_comment text;
  v_claim_token uuid;
  v_existing_status text;
  v_notification_error_code text;
  v_last_attempt_at timestamptz;
  v_notification_recorded boolean;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_dean_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.profiles AS dean
    WHERE dean.id = p_dean_id
      AND dean.role = 'dean'
  ) THEN
    RAISE EXCEPTION 'Only a Dean can request a decision notification.'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    letter.student_id,
    student.program_id,
    letter.status,
    student.full_name,
    NULLIF(pg_catalog.btrim(auth_user.email), ''),
    auth_user.email_confirmed_at IS NOT NULL,
    letter.submitted_at,
    letter.decided_at,
    letter.dean_comment
  INTO
    v_student_id,
    v_program_id,
    v_status,
    v_student_name,
    v_email,
    v_email_confirmed,
    v_submitted_at,
    v_decided_at,
    v_dean_comment
  FROM public.excuse_letters AS letter
  JOIN public.profiles AS student
    ON student.id = letter.student_id
   AND student.role = 'student'
  JOIN auth.users AS auth_user
    ON auth_user.id = student.id
  WHERE letter.id = p_letter_id
    AND letter.decided_by = p_dean_id
    AND letter.status IN ('approved', 'disapproved');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The decision was not found or was not made by this Dean.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.academic_programs AS program
    JOIN public.dean_program_assignments AS assignment
      ON assignment.program_id = program.id
     AND assignment.dean_id = p_dean_id
     AND assignment.revoked_at IS NULL
    WHERE program.id = v_program_id
      AND program.is_active IS TRUE
  ) THEN
    RAISE EXCEPTION 'This Dean is not currently assigned to the letter program.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.letter_status_events AS event
    WHERE event.letter_id = p_letter_id
      AND event.actor_id = p_dean_id
      AND event.old_status = 'pending'
      AND event.new_status = v_status
  ) THEN
    RAISE EXCEPTION 'The letter decision could not be verified.'
      USING ERRCODE = '42501';
  END IF;

  SELECT notification.status, notification.last_attempt_at
  INTO v_existing_status, v_last_attempt_at
  FROM public.student_decision_notifications AS notification
  WHERE notification.letter_id = p_letter_id
    AND notification.notification_type = v_status;

  IF v_existing_status = 'sent' THEN
    RETURN QUERY SELECT
      'already_sent'::text,
      v_student_name,
      v_email,
      v_submitted_at,
      v_decided_at,
      v_status,
      v_dean_comment,
      NULL::uuid;
    RETURN;
  END IF;

  IF v_existing_status = 'sending'
     AND v_last_attempt_at > v_now - INTERVAL '15 minutes' THEN
    RETURN QUERY SELECT
      'in_progress'::text,
      v_student_name,
      v_email,
      v_submitted_at,
      v_decided_at,
      v_status,
      v_dean_comment,
      NULL::uuid;
    RETURN;
  END IF;

  IF v_email IS NULL OR NOT v_email_confirmed THEN
    v_notification_error_code := CASE
      WHEN v_email IS NULL THEN 'MISSING_EMAIL'
      ELSE 'UNCONFIRMED_EMAIL'
    END;

    INSERT INTO public.student_decision_notifications AS existing (
      letter_id,
      student_id,
      notification_type,
      status,
      attempt_count,
      claim_token,
      last_attempt_at,
      sent_at,
      error_code
    )
    VALUES (
      p_letter_id,
      v_student_id,
      v_status,
      'failed',
      1,
      NULL,
      v_now,
      NULL,
      v_notification_error_code
    )
    ON CONFLICT (letter_id, notification_type) DO UPDATE
    SET student_id = EXCLUDED.student_id,
        status = 'failed',
        claim_token = NULL,
        last_attempt_at = v_now,
        sent_at = NULL,
        error_code = EXCLUDED.error_code
    WHERE existing.status = 'failed'
      OR (
        existing.status = 'sending'
        AND existing.last_attempt_at <= v_now - INTERVAL '15 minutes'
      )
    RETURNING existing.status INTO v_existing_status;

    v_notification_recorded := FOUND;
    IF NOT v_notification_recorded THEN
      SELECT notification.status
      INTO v_existing_status
      FROM public.student_decision_notifications AS notification
      WHERE notification.letter_id = p_letter_id
        AND notification.notification_type = v_status;
    END IF;

    RETURN QUERY SELECT
      CASE
        WHEN v_existing_status = 'sent' THEN 'already_sent'
        WHEN v_existing_status = 'sending' THEN 'in_progress'
        WHEN v_email IS NULL THEN 'missing_email'
        ELSE 'unconfirmed_email'
      END,
      v_student_name,
      NULL::text,
      v_submitted_at,
      v_decided_at,
      v_status,
      v_dean_comment,
      NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO public.student_decision_notifications AS existing (
    letter_id,
    student_id,
    notification_type,
    status,
    attempt_count,
    claim_token,
    last_attempt_at,
    sent_at,
    error_code
  )
  VALUES (
    p_letter_id,
    v_student_id,
    v_status,
    'sending',
    1,
    pg_catalog.gen_random_uuid(),
    v_now,
    NULL,
    NULL
  )
  ON CONFLICT (letter_id, notification_type) DO UPDATE
  SET student_id = EXCLUDED.student_id,
      status = 'sending',
      attempt_count = existing.attempt_count + 1,
      claim_token = EXCLUDED.claim_token,
      last_attempt_at = v_now,
      sent_at = NULL,
      error_code = NULL
  WHERE (
      existing.status = 'failed'
      AND existing.last_attempt_at <= v_now - INTERVAL '5 minutes'
    )
    OR (
      existing.status = 'sending'
      AND existing.last_attempt_at <= v_now - INTERVAL '15 minutes'
    )
  RETURNING existing.claim_token INTO v_claim_token;

  IF v_claim_token IS NOT NULL THEN
    RETURN QUERY SELECT
      'claimed'::text,
      v_student_name,
      v_email,
      v_submitted_at,
      v_decided_at,
      v_status,
      v_dean_comment,
      v_claim_token;
    RETURN;
  END IF;

  SELECT notification.status, notification.last_attempt_at
  INTO v_existing_status, v_last_attempt_at
  FROM public.student_decision_notifications AS notification
  WHERE notification.letter_id = p_letter_id
    AND notification.notification_type = v_status;

  RETURN QUERY SELECT
    CASE
      WHEN v_existing_status = 'sent' THEN 'already_sent'
      WHEN v_existing_status = 'sending' THEN 'in_progress'
      ELSE 'retry_wait'
    END,
    v_student_name,
    v_email,
    v_submitted_at,
    v_decided_at,
    v_status,
    v_dean_comment,
    NULL::uuid;
END;
$function$;

ALTER FUNCTION public.claim_student_decision_notification(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_student_decision_notification(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_student_decision_notification(uuid, uuid) TO service_role;

CREATE FUNCTION public.finish_student_decision_notification(
  p_letter_id uuid,
  p_notification_type text,
  p_claim_token uuid,
  p_status text,
  p_error_code text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'Notification status must be sent or failed.'
      USING ERRCODE = '22023';
  END IF;

  IF p_status = 'failed'
     AND (p_error_code IS NULL OR pg_catalog.length(p_error_code) > 64) THEN
    RAISE EXCEPTION 'A short error code is required for a failed notification.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.student_decision_notifications AS notification
  SET status = p_status,
      claim_token = NULL,
      sent_at = CASE
        WHEN p_status = 'sent' THEN pg_catalog.statement_timestamp()
        ELSE NULL
      END,
      error_code = CASE
        WHEN p_status = 'failed' THEN p_error_code
        ELSE NULL
      END
  WHERE notification.letter_id = p_letter_id
    AND notification.notification_type = p_notification_type
    AND notification.status = 'sending'
    AND notification.claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

ALTER FUNCTION public.finish_student_decision_notification(uuid, text, uuid, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_student_decision_notification(uuid, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_student_decision_notification(uuid, text, uuid, text, text)
  TO service_role;
