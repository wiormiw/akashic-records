import { OpenFgaClient, type AuthorizationModel } from '@openfga/sdk';
import { transformer } from '@openfga/syntax-transformer';
import * as v from 'valibot';
import { modelPath } from '@akashic/authz';
import { loadEnv, url } from '@akashic/lib/config';

// Pushes authz/model.fga to OpenFGA, creating the store on first run, and prints the ids the API
// needs. Only needs the OpenFGA address.
const STORE_NAME = 'akashic';

if (import.meta.main) {
	const env = loadEnv(v.object({ FGA_API_URL: url('http://localhost:8080') }), Bun.env);

	const model = transformer.transformDSLToJSONObject(
		await Bun.file(modelPath).text(),
	) as unknown as AuthorizationModel;

	const client = new OpenFgaClient({ apiUrl: env.FGA_API_URL });
	const { stores } = await client.listStores();
	const storeId =
		stores.find((store) => store.name === STORE_NAME)?.id ??
		(await client.createStore({ name: STORE_NAME })).id;

	client.storeId = storeId;
	const { authorization_model_id: modelId } = await client.writeAuthorizationModel(model);

	console.log(`FGA_STORE_ID=${storeId}`);
	console.log(`FGA_MODEL_ID=${modelId}`);
}
