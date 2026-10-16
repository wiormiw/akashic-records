import type { Module } from '../module.ts';
import { createUploadRoutes } from './upload.routes.ts';
import type { UploadModuleDeps } from './upload.types.ts';

/** Image uploads, judged by their bytes. */
export function createUploadModule(deps: UploadModuleDeps): Module {
	return { name: 'upload', routes: createUploadRoutes(deps) };
}
