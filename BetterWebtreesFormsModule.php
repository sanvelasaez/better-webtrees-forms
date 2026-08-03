<?php

declare(strict_types=1);

namespace BetterWebtreesForms;

use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Module\AbstractModule;
use Fisharebest\Webtrees\Module\ModuleCustomInterface;
use Fisharebest\Webtrees\Module\ModuleCustomTrait;
use Fisharebest\Webtrees\Module\ModuleGlobalInterface;
use Fisharebest\Webtrees\Module\ModuleGlobalTrait;

use function e;

/**
 * Better Webtrees Forms.
 *
 * Reemplaza los formularios de edición/creación de individuos (que en webtrees
 * navegan a una página completa) por popups AJAX. No modifica el core: se
 * limita a inyectar un CSS + JS global en todas las páginas mediante
 * ModuleGlobalInterface. Toda la lógica de interceptación vive en el bundle JS.
 */
final class BetterWebtreesFormsModule extends AbstractModule implements
    ModuleCustomInterface,
    ModuleGlobalInterface
{
    use ModuleCustomTrait;
    use ModuleGlobalTrait;

    public const CUSTOM_TITLE   = 'Better Webtrees Forms';
    public const CUSTOM_AUTHOR  = 'sanvelas';
    public const CUSTOM_VERSION = '1.0.0';

    public function customModuleAuthorName(): string
    {
        return self::CUSTOM_AUTHOR;
    }

    public function customModuleVersion(): string
    {
        return self::CUSTOM_VERSION;
    }

    public function title(): string
    {
        return self::CUSTOM_TITLE;
    }

    public function description(): string
    {
        return I18N::translate('Replaces individual edit/create forms with non-blocking AJAX popups.');
    }

    public function resourcesFolder(): string
    {
        return __DIR__ . '/resources/';
    }

    /**
     * Assets globales en el <head>. El bundle difiere su arranque a
     * DOMContentLoaded, así que es seguro cargarlo aquí. assetUrl() añade un
     * cache-buster basado en filemtime.
     */
    public function headContent(): string
    {
        return '<link rel="stylesheet" href="' . e($this->assetUrl('css/better-webtrees-forms.css')) . '">'
            . '<script src="' . e($this->assetUrl('js/better-webtrees-forms.js')) . '"></script>';
    }

    /**
     * Etiquetas propias del módulo en español (webtrees solo traduce sus
     * cadenas de core, no las de módulos custom).
     *
     * @return array<string, string>
     */
    public function customTranslations(string $language): array
    {
        if (str_starts_with($language, 'es')) {
            return [
                'Replaces individual edit/create forms with non-blocking AJAX popups.'
                    => 'Sustituye los formularios de edición/creación de individuos por popups AJAX sin bloqueo.',
            ];
        }

        return [];
    }
}
