import serverless from 'serverless-http';
import { createApp } from '../src/app';

/**
 * Serverless entry point for Vercel-style hosts.
 *
 * Deployment status: PREPARED BUT UNVERIFIED — no deployment has been
 * performed from this repository. See README.md for the required routing
 * configuration (/api/* must be forwarded to this function) and the
 * environment variables that must be configured on the host.
 */
const handler = serverless(createApp());

export default handler;
export { handler };
