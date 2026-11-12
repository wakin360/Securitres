-- Allow a daily Dean reminder even when there are no pending letters.
ALTER TABLE public.dean_daily_digest_logs
  DROP CONSTRAINT IF EXISTS dean_daily_digest_logs_pending_count_check;

ALTER TABLE public.dean_daily_digest_logs
  ADD CONSTRAINT dean_daily_digest_logs_pending_count_check CHECK (pending_count >= 0);

CREATE OR REPLACE FUNCTION public.claim_dean_daily_digests(p_digest_date date)
RETURNS TABLE (
  dean_id uuid,
  dean_email text,
  pending_count integer,
  claim_token uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  UPDATE public.dean_daily_digest_logs AS log
  SET status = 'failed',
      claim_token = NULL,
      error_message = 'Previous delivery claim expired.'
  WHERE log.digest_date = p_digest_date
    AND log.status = 'sending'
    AND log.last_attempt_at <= v_now - INTERVAL '15 minutes';

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      dean.id AS dean_id,
      auth_user.email::text AS dean_email,
      pg_catalog.count(DISTINCT letter.id)::integer AS pending_count
    FROM public.profiles AS dean
    JOIN auth.users AS auth_user
      ON auth_user.id = dean.id
     AND auth_user.email_confirmed_at IS NOT NULL
     AND auth_user.email IS NOT NULL
    JOIN public.dean_program_assignments AS assignment
      ON assignment.dean_id = dean.id
     AND assignment.revoked_at IS NULL
    JOIN public.academic_programs AS program
      ON program.id = assignment.program_id
     AND program.is_active IS TRUE
    LEFT JOIN public.profiles AS student
      ON student.program_id = program.id
     AND student.role = 'student'
    LEFT JOIN public.excuse_letters AS letter
      ON letter.student_id = student.id
     AND letter.status = 'pending'
    WHERE dean.role = 'dean'
    GROUP BY dean.id, auth_user.email
  ),
  claimed AS (
    INSERT INTO public.dean_daily_digest_logs AS existing (
      dean_id,
      digest_date,
      pending_count,
      status,
      attempt_count,
      claim_token,
      last_attempt_at,
      error_message,
      sent_at
    )
    SELECT
      eligible.dean_id,
      p_digest_date,
      eligible.pending_count,
      'sending',
      1,
      pg_catalog.gen_random_uuid(),
      v_now,
      NULL,
      NULL
    FROM eligible
    ON CONFLICT (dean_id, digest_date) DO UPDATE
    SET pending_count = EXCLUDED.pending_count,
        status = 'sending',
        attempt_count = existing.attempt_count + 1,
        claim_token = EXCLUDED.claim_token,
        last_attempt_at = v_now,
        error_message = NULL,
        sent_at = NULL
    WHERE (
        existing.status = 'failed'
        AND existing.last_attempt_at <= v_now - INTERVAL '5 minutes'
      )
      OR (
        existing.status = 'sending'
        AND existing.last_attempt_at <= v_now - INTERVAL '15 minutes'
      )
    RETURNING existing.dean_id, existing.pending_count, existing.claim_token
  )
  SELECT claimed.dean_id, eligible.dean_email, claimed.pending_count, claimed.claim_token
  FROM claimed
  JOIN eligible ON eligible.dean_id = claimed.dean_id;
END;
$function$;

ALTER FUNCTION public.claim_dean_daily_digests(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_dean_daily_digests(date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_dean_daily_digests(date) TO service_role;
