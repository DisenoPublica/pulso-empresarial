// Disparador semanal: lunes 12:00 UTC = lunes 9:00 AM Argentina.
// Las funciones programadas cortan a los 30 s, así que solo despierta a la
// función background, que hace el trabajo largo (Meltwater + Claude).

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  const res = await fetch(base + '/.netlify/functions/pulso-refresh-background', {
    method: 'POST',
    headers: { 'x-pulso-secreto': process.env.PULSO_SECRETO || '' }
  });
  console.log('refresco disparado:', res.status);
  return new Response(null, { status: 202 });
};

// Lunes 12:00 UTC = lunes 9:00 AM Argentina.
export const config = { schedule: '0 12 * * 1' };
