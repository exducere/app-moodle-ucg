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

import { Component, CUSTOM_ELEMENTS_SCHEMA, OnDestroy, OnInit, inject, signal } from '@angular/core';

import { DownloadStatus } from '@/core/constants';
import { CoreSharedModule } from '@/core/shared.module';
import { AddonBlockRecentlyAccessedItemsComponent } from
    '@addons/block/recentlyaccesseditems/components/recentlyaccesseditems/recentlyaccesseditems';
import { AddonCourseCompletion } from '@addons/coursecompletion/services/coursecompletion';
import { PageLoadsManager } from '@classes/page-loads-manager';
import { PageLoadWatcher } from '@classes/page-load-watcher';
import { CoreSite } from '@classes/sites/site';
import { CoreCourseDownloadStatusIcon } from '@features/course/constants';
import { CoreCourseOptionsDelegate } from '@features/course/services/course-options-delegate';
import { CoreCoursePrefetch, CorePrefetchStatusInfo } from '@features/course/services/course-prefetch';
import { CoreCoursesCourseListItemComponent } from '@features/courses/components/course-list-item/course-list-item';
import {
    CORE_COURSES_MY_COURSES_UPDATED_EVENT,
    CORE_COURSES_STATE_FAVOURITE,
    CORE_COURSES_STATE_HIDDEN,
    CoreCoursesMyCoursesUpdatedEventAction,
} from '@features/courses/constants';
import { CoreCourses, CoreCoursesMyCoursesUpdatedEventData } from '@features/courses/services/courses';
import { CoreCoursesHelper, CoreEnrolledCourseDataWithExtraInfoAndOptions } from '@features/courses/services/courses-helper';
import { CoreAlerts } from '@services/overlays/alerts';
import { CoreSites, CoreSitesReadingStrategy } from '@services/sites';
import { CorePromiseUtils } from '@static/promise-utils';
import { CoreTime } from '@static/time';
import { CoreEventObserver, CoreEvents } from '@static/events';
import type { AsyncDirective } from '@coretypes/async-directive';
import { CoreMainMenuUserButtonComponent } from '../../components/user-menu-button/user-menu-button';

type HomeCourseFilter = 'allincludinghidden' | 'all' | 'inprogress' | 'future' | 'past' | 'favourite' | 'hidden';

const FILTER_PRIORITY: HomeCourseFilter[] =
    ['all', 'inprogress', 'future', 'past', 'favourite', 'allincludinghidden', 'hidden'];

/**
 * Page that displays the main menu home with a direct course carousel.
 */
@Component({
    selector: 'page-core-mainmenu-home',
    templateUrl: 'home.html',
    styleUrl: 'home.scss',
    imports: [
        CoreSharedModule,
        CoreMainMenuUserButtonComponent,
        CoreCoursesCourseListItemComponent,
        AddonBlockRecentlyAccessedItemsComponent,
    ],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export default class CoreMainMenuHomePage implements OnInit, OnDestroy, AsyncDirective {

    filteredCourses: CoreEnrolledCourseDataWithExtraInfoAndOptions[] = [];
    filterCounts: Partial<Record<HomeCourseFilter, number>> = {};
    readonly recentBlock = signal({
        name: 'recentlyaccesseditems',
        visible: true,
        region: 'content',
        instanceid: 0,
    });

    prefetchCoursesData: CorePrefetchStatusInfo = {
        icon: CoreCourseDownloadStatusIcon.NOT_DOWNLOADABLE,
        statusTranslatable: 'core.loading',
        status: DownloadStatus.DOWNLOADABLE_NOT_DOWNLOADED,
        loading: true,
    };

    filters = {
        enabled: false,
        show: {
            allincludinghidden: true,
            all: true,
            past: true,
            inprogress: true,
            future: true,
            favourite: true,
            hidden: true,
        } as Record<HomeCourseFilter, boolean>,
        timeFilterSelected: 'allincludinghidden' as HomeCourseFilter,
    };

    sort = {
        shortnameEnabled: false,
        selected: 'fullname',
        enabled: false,
    };

    textFilter = '';
    hasCourses = false;
    loaded = false;
    siteUserName = '';
    downloadCourseEnabled = false;
    userId: number;

    protected currentSite: CoreSite;
    protected allCourses: CoreEnrolledCourseDataWithExtraInfoAndOptions[] = [];
    protected prefetchIconsInitialized = false;
    protected isDirty = false;
    protected isDestroyed = false;
    protected coursesObserver?: CoreEventObserver;
    protected updateSiteObserver?: CoreEventObserver;
    protected gradePeriodAfter = 0;
    protected gradePeriodBefore = 0;
    protected firstLoadWatcher?: PageLoadWatcher;
    protected loadsManager: PageLoadsManager;

    constructor() {
        this.currentSite = CoreSites.getRequiredCurrentSite();
        this.userId = CoreSites.getCurrentSiteUserId();

        const loadsManager = inject(PageLoadsManager, { optional: true });
        this.loadsManager = loadsManager ?? new PageLoadsManager();
    }

    /**
     * @inheritdoc
     */
    async ready(): Promise<void> {
        // The page can be displayed while its content loader resolves.
    }

    /**
     * @inheritdoc
     */
    async ngOnInit(): Promise<void> {
        this.firstLoadWatcher = this.loadsManager.startComponentLoad(this);
        this.siteUserName = this.currentSite.infos?.fullname || '';
        this.downloadCourseEnabled = !CoreCourses.isDownloadCourseDisabledInSite();

        this.updateSiteObserver = CoreEvents.on(CoreEvents.SITE_UPDATED, () => {
            this.downloadCourseEnabled = !CoreCourses.isDownloadCourseDisabledInSite();
        }, CoreSites.getCurrentSiteId());

        this.coursesObserver = CoreEvents.on(
            CORE_COURSES_MY_COURSES_UPDATED_EVENT,
            data => this.refreshCourseList(data),
            CoreSites.getCurrentSiteId(),
        );

        const [savedSort, savedFilter] = await Promise.all([
            this.currentSite.getLocalSiteConfig('AddonBlockMyOverviewSort', this.sort.selected),
            this.currentSite.getLocalSiteConfig('AddonBlockMyOverviewFilter', this.filters.timeFilterSelected),
        ]);

        this.sort.selected = savedSort;
        this.filters.timeFilterSelected = this.isKnownFilter(savedFilter) ? savedFilter : 'allincludinghidden';

        CoreSites.loginNavigationFinished();
        await this.loadContent();
    }

    /**
     * Load courses and their filtering configuration.
     */
    protected async loadContent(): Promise<void> {
        try {
            const loadWatcher = this.firstLoadWatcher ?? this.loadsManager.startComponentLoad(this);
            this.firstLoadWatcher = undefined;

            await Promise.all([
                this.loadAllCourses(loadWatcher),
                this.loadGracePeriod(loadWatcher),
            ]);

            this.loadSort();
            await this.loadFilters();
        } catch (error) {
            CoreAlerts.showError(error, { default: 'Error getting my overview data.' });
        }

        this.isDirty = false;
        this.loaded = true;
    }

    /**
     * Load all courses available to the current user.
     *
     * @param loadWatcher Page load watcher.
     */
    protected async loadAllCourses(loadWatcher: PageLoadWatcher): Promise<void> {
        this.allCourses = await loadWatcher.watchRequest(
            CoreCoursesHelper.getUserCoursesWithOptionsObservable({
                sort: this.sort.selected,
                loadCategoryNames: true,
                readingStrategy: this.isDirty ? CoreSitesReadingStrategy.PREFER_NETWORK : loadWatcher.getReadingStrategy(),
            }),
            (previousCourses, newCourses) => this.coursesHaveMeaningfulChanges(previousCourses, newCourses),
        );

        this.hasCourses = this.allCourses.length > 0;
    }

    /**
     * Load Moodle's course start and end grace periods.
     *
     * @param loadWatcher Page load watcher.
     */
    protected async loadGracePeriod(loadWatcher: PageLoadWatcher): Promise<void> {
        try {
            const siteConfig = await loadWatcher.watchRequest(
                this.currentSite.getConfigObservable(
                    undefined,
                    this.isDirty ? CoreSitesReadingStrategy.PREFER_NETWORK : loadWatcher.getReadingStrategy(),
                ),
            );

            this.gradePeriodAfter = parseInt(siteConfig.coursegraceperiodafter, 10) || 0;
            this.gradePeriodBefore = parseInt(siteConfig.coursegraceperiodbefore, 10) || 0;
        } catch {
            this.gradePeriodAfter = 0;
            this.gradePeriodBefore = 0;
        }
    }

    /**
     * Load the available sort configuration.
     */
    protected loadSort(): void {
        const sampleCourse = this.allCourses[0];

        this.sort.shortnameEnabled = !!sampleCourse?.displayname && !!sampleCourse?.shortname &&
            sampleCourse.fullname !== sampleCourse.displayname;

        if (!this.sort.shortnameEnabled && this.sort.selected === 'shortname') {
            this.saveSort('fullname');
        }

        this.sort.enabled = sampleCourse?.lastaccess !== undefined;
    }

    /**
     * Load filters supported by the course data.
     */
    protected async loadFilters(): Promise<void> {
        const sampleCourse = this.allCourses[0];

        this.filters.show.favourite = sampleCourse?.isfavourite !== undefined;
        this.filters.show.hidden = sampleCourse?.hidden !== undefined;
        this.filters.enabled = this.hasCourses;

        await this.filterCourses();
    }

    /**
     * Refresh the page using fresh Moodle data.
     */
    async refreshContent(): Promise<void> {
        this.isDirty = true;
        this.loaded = false;

        try {
            await this.invalidateCourses(this.allCourses.map(course => course.id));
        } catch {
            // Keep cached data available if invalidation fails.
        }

        await this.loadContent();
    }

    /**
     * Invalidate course data required by the home page.
     *
     * @param courseIds Course IDs to invalidate.
     */
    protected async invalidateCourses(courseIds: number[]): Promise<void> {
        const promises: Promise<void>[] = [];

        promises.push(CoreCourses.invalidateUserCourses().finally(() =>
            CorePromiseUtils.allPromises(courseIds.map(courseId =>
                AddonCourseCompletion.invalidateCourseCompletion(courseId)))));

        promises.push(courseIds.length === 1
            ? CoreCourseOptionsDelegate.clearAndInvalidateCoursesOptions(courseIds[0])
            : CoreCourseOptionsDelegate.clearAndInvalidateCoursesOptions());

        if (courseIds.length > 0) {
            promises.push(CoreCourses.invalidateCoursesByField('ids', courseIds.join(',')));
        }

        await CorePromiseUtils.allPromises(promises).finally(() => {
            this.prefetchIconsInitialized = false;
        });
    }

    /**
     * Complete a pull-to-refresh action.
     *
     * @param refresher Refresher element.
     */
    async doRefresh(refresher?: HTMLIonRefresherElement): Promise<void> {
        await this.refreshContent();
        refresher?.complete();
    }

    /**
     * Update the local text filter.
     *
     * @param target Input event target.
     */
    filterTextChanged(target: EventTarget | null): void {
        const value = (target as HTMLIonInputElement | null)?.value;
        this.textFilter = value === undefined || value === null ? '' : String(value);
        this.filterCourses();
    }

    /**
     * Select a course time filter.
     *
     * @param value Selected filter.
     */
    selectFilter(value: HomeCourseFilter): void {
        this.filters.timeFilterSelected = value;
        this.filterCourses();
    }

    /**
     * Filter and sort courses for the carousel.
     */
    protected async filterCourses(): Promise<void> {
        let timeFilter = this.filters.timeFilterSelected;

        this.computeFilterCounts();

        if (!this.filters.show[timeFilter]) {
            timeFilter = FILTER_PRIORITY.find(filter => this.filters.show[filter]) || 'all';
        }

        this.filteredCourses = [...this.allCourses];
        await this.saveFilters(timeFilter);

        switch (timeFilter) {
            case 'allincludinghidden':
                break;
            case 'all':
                this.filteredCourses = this.filteredCourses.filter(course => !course.hidden);
                break;
            case 'inprogress':
                this.filteredCourses = this.filteredCourses.filter(course => this.isInProgress(course));
                break;
            case 'future':
                this.filteredCourses = this.filteredCourses.filter(course =>
                    !course.hidden && CoreCoursesHelper.isFutureCourse(
                        course,
                        this.gradePeriodAfter,
                        this.gradePeriodBefore,
                    ));
                break;
            case 'past':
                this.filteredCourses = this.filteredCourses.filter(course =>
                    !course.hidden && CoreCoursesHelper.isPastCourse(course, this.gradePeriodAfter));
                break;
            case 'favourite':
                this.filteredCourses = this.filteredCourses.filter(course => !course.hidden && course.isfavourite);
                break;
            case 'hidden':
                this.filteredCourses = this.filteredCourses.filter(course => course.hidden);
                break;
        }

        const search = this.textFilter.trim().toLocaleLowerCase();
        if (search) {
            this.filteredCourses = this.filteredCourses.filter(course =>
                (course.displayname || course.fullname).toLocaleLowerCase().includes(search));
        }

        this.sortCourses();
        this.prefetchIconsInitialized = false;
        this.initPrefetchCoursesIcons();
    }

    /**
     * Count courses in each visible filter.
     */
    protected computeFilterCounts(): void {
        this.filterCounts = {
            allincludinghidden: this.allCourses.length,
            all: this.allCourses.filter(course => !course.hidden).length,
            inprogress: this.allCourses.filter(course => this.isInProgress(course)).length,
            future: this.allCourses.filter(course =>
                !course.hidden && CoreCoursesHelper.isFutureCourse(
                    course,
                    this.gradePeriodAfter,
                    this.gradePeriodBefore,
                )).length,
            past: this.allCourses.filter(course =>
                !course.hidden && CoreCoursesHelper.isPastCourse(course, this.gradePeriodAfter)).length,
            favourite: this.allCourses.filter(course => !course.hidden && course.isfavourite).length,
            hidden: this.allCourses.filter(course => course.hidden).length,
        };
    }

    /**
     * Check whether a course is active now.
     *
     * @param course Course to check.
     * @returns Whether the course is in progress.
     */
    protected isInProgress(course: CoreEnrolledCourseDataWithExtraInfoAndOptions): boolean {
        return !course.hidden &&
            !CoreCoursesHelper.isPastCourse(course, this.gradePeriodAfter) &&
            !CoreCoursesHelper.isFutureCourse(course, this.gradePeriodAfter, this.gradePeriodBefore);
    }

    /**
     * Sort visible courses using the stored preference.
     */
    protected sortCourses(): void {
        if (!this.sort.enabled) {
            return;
        }

        if (this.sort.selected === 'lastaccess') {
            this.filteredCourses.sort((a, b) => (b.lastaccess || 0) - (a.lastaccess || 0));
        } else if (this.sort.selected === 'shortname') {
            this.filteredCourses.sort((a, b) => a.shortname.toLocaleLowerCase().localeCompare(b.shortname.toLocaleLowerCase()));
        } else {
            this.filteredCourses.sort((a, b) => a.fullname.toLocaleLowerCase().localeCompare(b.fullname.toLocaleLowerCase()));
        }
    }

    /**
     * Persist the selected filter.
     *
     * @param timeFilter Filter to persist.
     */
    protected async saveFilters(timeFilter: HomeCourseFilter): Promise<void> {
        this.filters.timeFilterSelected = timeFilter;
        await this.currentSite.setLocalSiteConfig('AddonBlockMyOverviewFilter', timeFilter);
    }

    /**
     * Persist the selected sort mode.
     *
     * @param sort Sort mode to persist.
     */
    protected async saveSort(sort: string): Promise<void> {
        this.sort.selected = sort;
        await this.currentSite.setLocalSiteConfig('AddonBlockMyOverviewSort', sort);
    }

    /**
     * Initialize download states for visible courses.
     */
    protected async initPrefetchCoursesIcons(): Promise<void> {
        if (this.prefetchIconsInitialized) {
            return;
        }

        this.prefetchIconsInitialized = true;
        this.prefetchCoursesData = await CoreCoursePrefetch.initPrefetchCoursesIcons(
            this.filteredCourses,
            this.prefetchCoursesData,
        );
    }

    /**
     * React to course favourite, hidden and viewed events.
     *
     * @param data Course update event data.
     * @returns Promise resolved when the update has been handled.
     */
    protected async refreshCourseList(data: CoreCoursesMyCoursesUpdatedEventData): Promise<void> {
        if (data.action === CoreCoursesMyCoursesUpdatedEventAction.ENROL) {
            return this.refreshContent();
        }

        const course = this.allCourses.find(course => course.id === data.courseId);

        if (data.action === CoreCoursesMyCoursesUpdatedEventAction.STATE_CHANGED) {
            if (!course) {
                return this.refreshContent();
            }

            if (data.state === CORE_COURSES_STATE_FAVOURITE) {
                course.isfavourite = !!data.value;
            } else if (data.state === CORE_COURSES_STATE_HIDDEN) {
                course.hidden = !!data.value;
            }

            await CoreCourses.invalidateUserCourses();
            await this.filterCourses();
        } else if (
            data.action === CoreCoursesMyCoursesUpdatedEventAction.VIEW &&
            data.courseId !== CoreSites.getCurrentSiteHomeId()
        ) {
            if (!course) {
                return this.refreshContent();
            }

            course.lastaccess = CoreTime.timestamp();
            await CoreCourses.invalidateUserCourses();
            await this.filterCourses();
        }
    }

    /**
     * Check whether a stored filter is supported by this page.
     *
     * @param value Stored filter value.
     * @returns Whether the value is a known filter.
     */
    protected isKnownFilter(value: string): value is HomeCourseFilter {
        return FILTER_PRIORITY.includes(value as HomeCourseFilter);
    }

    /**
     * Compare cached and refreshed course lists.
     *
     * @param previousCourses Cached courses.
     * @param newCourses Refreshed courses.
     * @returns Whether meaningful course data changed.
     */
    protected async coursesHaveMeaningfulChanges(
        previousCourses: CoreEnrolledCourseDataWithExtraInfoAndOptions[],
        newCourses: CoreEnrolledCourseDataWithExtraInfoAndOptions[],
    ): Promise<boolean> {
        if (previousCourses.length !== newCourses.length) {
            return true;
        }

        const previous = [...previousCourses].sort((a, b) => a.id - b.id);
        const current = [...newCourses].sort((a, b) => a.id - b.id);

        return previous.some((course, index) =>
            course.progress !== current[index].progress ||
            course.categoryname !== current[index].categoryname ||
            (course.displayname || course.fullname) !== (current[index].displayname || current[index].fullname));
    }

    /**
     * @inheritdoc
     */
    ngOnDestroy(): void {
        this.isDestroyed = true;
        this.coursesObserver?.off();
        this.updateSiteObserver?.off();
    }

}
