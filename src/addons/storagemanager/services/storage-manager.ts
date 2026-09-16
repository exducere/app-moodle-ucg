// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable, Type } from '@angular/core';
import { makeSingleton } from '@singletons';

/**
 * Service that provides some features regarding storage management.
 */
@Injectable({ providedIn: 'root' })
export class CoreStorageManagerService {

    /**
     * Get the class of the component to render a custom footer on the storage page.
     * If not defined, the default component will be used.
     * This method can be overridden in subclasses to provide a custom component to render the custom footer.
     *
     * @returns The class of the component to render a custom footer, or `undefined` to use the default component.
     */
    async getFooterComponent(): Promise<Type<unknown> | undefined> {
        return undefined;
    }

}
export const CoreStorageManager = makeSingleton(CoreStorageManagerService);
