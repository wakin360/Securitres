const commentBatchSize = 500;

export async function getAuthorizedLetterComments(client, letterIds) {
  const commentsByLetterId = new Map();

  for (let offset = 0; offset < letterIds.length; offset += commentBatchSize) {
    const { data, error } = await client.rpc('get_authorized_letter_comments', {
      p_letter_ids: letterIds.slice(offset, offset + commentBatchSize),
    });

    if (error) throw error;
    for (const comment of data || []) {
      commentsByLetterId.set(comment.letter_id, comment.dean_comment);
    }
  }

  return commentsByLetterId;
}

export async function getAuthorizedLetterStatusHistoryComments(client, letterId) {
  const { data, error } = await client.rpc('get_authorized_letter_status_history_comments', {
    p_letter_id: letterId,
  });

  if (error) throw error;
  return data || [];
}
