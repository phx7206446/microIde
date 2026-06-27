/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IMicroClaudeSidecarService, MicroClaudeSidecarChannelName } from '../common/microClaudeSidecarService.js';

// @ts-expect-error: interface is implemented by the IPC proxy returned from the constructor.
export class NativeMicroClaudeSidecarService implements IMicroClaudeSidecarService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService
	) {
		return ProxyChannel.toService<IMicroClaudeSidecarService>(mainProcessService.getChannel(MicroClaudeSidecarChannelName));
	}
}

registerSingleton(IMicroClaudeSidecarService, NativeMicroClaudeSidecarService, InstantiationType.Delayed);
