import { api } from '$lib/api/client';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
  try {
    return await api.getProject(params.id);
  } catch (e) {
    throw error(404, e instanceof Error ? e.message : 'project not found');
  }
};
